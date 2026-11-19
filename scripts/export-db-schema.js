import sequelize from '../src/config/database.js';
import { QueryTypes } from 'sequelize';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../src/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function exportDatabaseSchema() {
  try {
    logger.info('Connecting to database', { component: 'export-db-schema' });
    await sequelize.authenticate();
    logger.info('Database connection established', { component: 'export-db-schema' });

    const exportData = {
      exportedAt: new Date().toISOString(),
      database: process.env.DB_NAME,
      schemas: []
    };

    const schemas = await sequelize.query(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_toast_temp_1')
       ORDER BY schema_name`,
      { type: QueryTypes.SELECT }
    );
    logger.info('Fetched schemas', { component: 'export-db-schema', count: schemas.length });

    for (const schema of schemas) {
      const schemaName = schema.schema_name;
      logger.info('Processing schema', { component: 'export-db-schema', schema: schemaName });

      const schemaData = {
        name: schemaName,
        tables: []
      };

      const tables = await sequelize.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = :schemaName
           AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        {
          type: QueryTypes.SELECT,
          replacements: { schemaName }
        }
      );

      if (tables.length === 0) {
        logger.warn('No tables found in schema', { component: 'export-db-schema', schema: schemaName });
        continue;
      }
      logger.info('Processing tables', { component: 'export-db-schema', schema: schemaName, count: tables.length });

      for (const table of tables) {
        const tableName = table.table_name;

        const tableData = {
          name: tableName,
          columns: [],
          primaryKeys: [],
          foreignKeys: [],
          uniqueConstraints: [],
          indexes: [],
          checkConstraints: [],
          rowCount: 0
        };

        const columns = await sequelize.query(
          `SELECT
            column_name,
            ordinal_position,
            data_type,
            udt_name,
            character_maximum_length,
            numeric_precision,
            numeric_scale,
            is_nullable,
            column_default,
            is_identity,
            identity_generation,
            identity_start,
            identity_increment
           FROM information_schema.columns
           WHERE table_schema = :schemaName
             AND table_name = :tableName
           ORDER BY ordinal_position`,
          {
            type: QueryTypes.SELECT,
            replacements: { schemaName, tableName }
          }
        );

        const primaryKeys = await sequelize.query(
          `SELECT
            kcu.column_name,
            kcu.ordinal_position
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
           WHERE tc.table_schema = :schemaName
             AND tc.table_name = :tableName
             AND tc.constraint_type = 'PRIMARY KEY'
           ORDER BY kcu.ordinal_position`,
          {
            type: QueryTypes.SELECT,
            replacements: { schemaName, tableName }
          }
        );

        const foreignKeys = await sequelize.query(
          `SELECT
            kcu.column_name,
            kcu.ordinal_position,
            ccu.table_schema AS foreign_table_schema,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name,
            rc.update_rule,
            rc.delete_rule,
            tc.constraint_name
           FROM information_schema.table_constraints AS tc
           JOIN information_schema.key_column_usage AS kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
           JOIN information_schema.constraint_column_usage AS ccu
             ON ccu.constraint_name = tc.constraint_name
           JOIN information_schema.referential_constraints AS rc
             ON rc.constraint_name = tc.constraint_name
           WHERE tc.constraint_type = 'FOREIGN KEY'
             AND tc.table_schema = :schemaName
             AND tc.table_name = :tableName
           ORDER BY kcu.ordinal_position`,
          {
            type: QueryTypes.SELECT,
            replacements: { schemaName, tableName }
          }
        );

        const uniqueConstraints = await sequelize.query(
          `SELECT
            kcu.column_name,
            tc.constraint_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
           WHERE tc.table_schema = :schemaName
             AND tc.table_name = :tableName
             AND tc.constraint_type = 'UNIQUE'
             AND tc.constraint_name NOT LIKE '%_pkey'
           ORDER BY kcu.column_name`,
          {
            type: QueryTypes.SELECT,
            replacements: { schemaName, tableName }
          }
        );

        const indexes = await sequelize.query(
          `SELECT
            indexname,
            indexdef
           FROM pg_indexes
           WHERE schemaname = :schemaName
             AND tablename = :tableName
             AND indexname NOT LIKE '%_pkey'
           ORDER BY indexname`,
          {
            type: QueryTypes.SELECT,
            replacements: { schemaName, tableName }
          }
        );

        const checkConstraints = await sequelize.query(
          `SELECT
            constraint_name,
            check_clause
           FROM information_schema.check_constraints
           WHERE constraint_schema = :schemaName
             AND constraint_name IN (
               SELECT constraint_name
               FROM information_schema.table_constraints
               WHERE table_schema = :schemaName
                 AND table_name = :tableName
                 AND constraint_type = 'CHECK'
             )`,
          {
            type: QueryTypes.SELECT,
            replacements: { schemaName, tableName }
          }
        );

        try {
          const rowCountResult = await sequelize.query(
            `SELECT COUNT(*) as count FROM "${schemaName}"."${tableName}"`,
            {
              type: QueryTypes.SELECT,
              replacements: { schemaName, tableName }
            }
          );
          tableData.rowCount = parseInt(rowCountResult[0]?.count || 0);
        } catch (err) {
          void err;

          tableData.rowCount = 0;
        }

        columns.forEach(col => {
          const isPK = primaryKeys.some(pk => pk.column_name === col.column_name);
          const isFK = foreignKeys.some(fk => fk.column_name === col.column_name);
          const isUnique = uniqueConstraints.some(uc => uc.column_name === col.column_name);

          let dataType = col.data_type;

          if (col.character_maximum_length) {
            dataType += `(${col.character_maximum_length})`;
          } else if (col.numeric_precision) {
            dataType += `(${col.numeric_precision}`;
            if (col.numeric_scale) {
              dataType += `,${col.numeric_scale}`;
            }
            dataType += ')';
          }

          if (col.udt_name && col.udt_name.startsWith('_')) {
            dataType = col.udt_name.substring(1) + '[]';
          }

          if (col.data_type === 'USER-DEFINED') {
            dataType = col.udt_name;
          }

          const columnData = {
            name: col.column_name,
            position: col.ordinal_position,
            dataType: dataType,
            udtName: col.udt_name,
            nullable: col.is_nullable === 'YES',
            defaultValue: col.column_default,
            isPrimaryKey: isPK,
            isForeignKey: isFK,
            isUnique: isUnique,
            isIdentity: col.is_identity === 'YES',
            identityGeneration: col.identity_generation,
            identityStart: col.identity_start,
            identityIncrement: col.identity_increment
          };

          tableData.columns.push(columnData);
        });

        tableData.primaryKeys = primaryKeys.map(pk => pk.column_name);

        tableData.foreignKeys = foreignKeys.map(fk => ({
          column: fk.column_name,
          references: {
            schema: fk.foreign_table_schema,
            table: fk.foreign_table_name,
            column: fk.foreign_column_name
          },
          onUpdate: fk.update_rule,
          onDelete: fk.delete_rule,
          constraintName: fk.constraint_name
        }));

        tableData.uniqueConstraints = uniqueConstraints.map(uc => ({
          column: uc.column_name,
          constraintName: uc.constraint_name
        }));

        tableData.indexes = indexes.map(idx => ({
          name: idx.indexname,
          definition: idx.indexdef
        }));

        tableData.checkConstraints = checkConstraints.map(cc => ({
          name: cc.constraint_name,
          clause: cc.check_clause
        }));

        schemaData.tables.push(tableData);
      }

      exportData.schemas.push(schemaData);
      logger.info('Schema processed', { component: 'export-db-schema', schema: schemaName });
    }

    const jsonPath = path.join(__dirname, '..', 'database-schema-export.json');
    fs.writeFileSync(jsonPath, JSON.stringify(exportData, null, 2), 'utf8');
    logger.info('JSON export saved', { component: 'export-db-schema', path: jsonPath });

    let markdown = `# Database Schema Export\n\n`;
    markdown += `**Exported at:** ${new Date(exportData.exportedAt).toLocaleString()}\n`;
    markdown += `**Database:** ${exportData.database}\n\n`;
    markdown += `---\n\n`;

    exportData.schemas.forEach(schema => {
      markdown += `## Schema: \`${schema.name}\`\n\n`;

      schema.tables.forEach(table => {
        markdown += `### Table: \`${table.name}\`\n\n`;
        markdown += `**Row Count:** ${table.rowCount}\n\n`;

        markdown += `#### Columns\n\n`;
        markdown += `| Column | Type | Nullable | Default | Primary Key | Foreign Key | Unique |\n`;
        markdown += `|--------|------|----------|---------|-------------|-------------|--------|\n`;

        table.columns.forEach(col => {
          const pk = col.isPrimaryKey ? '🔑' : '';
          const fk = col.isForeignKey ? '🔗' : '';
          const unique = col.isUnique ? '✨' : '';
          const nullable = col.nullable ? 'YES' : 'NO';
          const defaultValue = col.defaultValue || '-';

          markdown += `| ${col.name} ${pk}${fk}${unique} | ${col.dataType} | ${nullable} | ${defaultValue} | ${col.isPrimaryKey ? 'Yes' : 'No'} | ${col.isForeignKey ? 'Yes' : 'No'} | ${col.isUnique ? 'Yes' : 'No'} |\n`;
        });

        markdown += `\n`;

        if (table.foreignKeys.length > 0) {
          markdown += `#### Foreign Keys\n\n`;
          table.foreignKeys.forEach(fk => {
            markdown += `- \`${fk.column}\` → \`${fk.references.schema}.${fk.references.table}.${fk.references.column}\` `;
            markdown += `(ON UPDATE: ${fk.onUpdate}, ON DELETE: ${fk.onDelete})\n`;
          });
          markdown += `\n`;
        }

        if (table.uniqueConstraints.length > 0) {
          markdown += `#### Unique Constraints\n\n`;
          table.uniqueConstraints.forEach(uc => {
            markdown += `- \`${uc.column}\` (constraint: \`${uc.constraintName}\`)\n`;
          });
          markdown += `\n`;
        }

        if (table.indexes.length > 0) {
          markdown += `#### Indexes\n\n`;
          table.indexes.forEach(idx => {
            markdown += `- **${idx.name}**: \`${idx.definition}\`\n`;
          });
          markdown += `\n`;
        }

        if (table.checkConstraints.length > 0) {
          markdown += `#### Check Constraints\n\n`;
          table.checkConstraints.forEach(cc => {
            markdown += `- **${cc.name}**: \`${cc.clause}\`\n`;
          });
          markdown += `\n`;
        }

        markdown += `---\n\n`;
      });
    });

    const mdPath = path.join(__dirname, '..', 'database-schema-export.md');
    fs.writeFileSync(mdPath, markdown, 'utf8');
    logger.info('Markdown export saved', { component: 'export-db-schema', path: mdPath });

    const totalTables = exportData.schemas.reduce((sum, s) => sum + s.tables.length, 0);
    const totalColumns = exportData.schemas.reduce(
      (sum, s) => sum + s.tables.reduce((tSum, t) => tSum + t.columns.length, 0),
      0
    );
    logger.info('Export completed', {
      component: 'export-db-schema',
      schemas: exportData.schemas.length,
      tables: totalTables,
      columns: totalColumns
    });
  } catch (error) {
    logger.error('Error exporting database schema', {
      component: 'export-db-schema',
      error: error?.message,
      stack: error?.stack
    });
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

exportDatabaseSchema();
