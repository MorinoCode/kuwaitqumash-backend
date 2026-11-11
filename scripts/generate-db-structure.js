import sequelize from '../src/config/database.js';
import { QueryTypes } from 'sequelize';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../src/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function generateDatabaseStructure() {
  try {
    logger.info('Connecting to database', { component: 'generate-db-structure' });
    await sequelize.authenticate();
    logger.info('Database connection established', { component: 'generate-db-structure' });

    let output = '# Database Structure - Auto Generated\n\n';
    output += `**Generated at:** ${new Date().toISOString()}\n\n`;
    output += '---\n\n';

    const schemas = await sequelize.query(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       ORDER BY schema_name`,
      { type: QueryTypes.SELECT }
    );

    output += '## Schemas\n\n';
    schemas.forEach(s => {
      output += `- \`${s.schema_name}\`\n`;
    });
    output += '\n---\n\n';

    for (const schema of schemas) {
      const schemaName = schema.schema_name;
      logger.info('Processing schema', { component: 'generate-db-structure', schema: schemaName });

      const tables = await sequelize.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = :schemaName
         ORDER BY table_name`,
        {
          type: QueryTypes.SELECT,
          replacements: { schemaName }
        }
      );

      if (tables.length === 0) {
        logger.warn('No tables found in schema', { component: 'generate-db-structure', schema: schemaName });
        continue;
      }

      output += `## Schema: \`${schemaName}\`\n\n`;

      for (const table of tables) {
        const tableName = table.table_name;

        const columns = await sequelize.query(
          `SELECT
            column_name,
            data_type,
            character_maximum_length,
            numeric_precision,
            numeric_scale,
            is_nullable,
            column_default,
            udt_name
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
          `SELECT column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
           WHERE tc.table_schema = :schemaName
             AND tc.table_name = :tableName
             AND tc.constraint_type = 'PRIMARY KEY'`,
          {
            type: QueryTypes.SELECT,
            replacements: { schemaName, tableName }
          }
        );

        const foreignKeys = await sequelize.query(
          `SELECT
            kcu.column_name,
            ccu.table_schema AS foreign_table_schema,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name
           FROM information_schema.table_constraints AS tc
           JOIN information_schema.key_column_usage AS kcu
             ON tc.constraint_name = kcu.constraint_name
           JOIN information_schema.constraint_column_usage AS ccu
             ON ccu.constraint_name = tc.constraint_name
           WHERE tc.constraint_type = 'FOREIGN KEY'
             AND tc.table_schema = :schemaName
             AND tc.table_name = :tableName`,
          {
            type: QueryTypes.SELECT,
            replacements: { schemaName, tableName }
          }
        );

        const uniqueConstraints = await sequelize.query(
          `SELECT column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
           WHERE tc.table_schema = :schemaName
             AND tc.table_name = :tableName
             AND tc.constraint_type = 'UNIQUE'
             AND tc.constraint_name NOT LIKE '%_pkey'`,
          {
            type: QueryTypes.SELECT,
            replacements: { schemaName, tableName }
          }
        );

        output += `### Table: \`${tableName}\`\n\n`;

        output += '| Column | Type | Nullable | Default | Description |\n';
        output += '|--------|------|----------|---------|-------------|\n';

        columns.forEach(col => {
          let type = col.data_type;

          if (col.character_maximum_length) {
            type += `(${col.character_maximum_length})`;
          } else if (col.numeric_precision) {
            type += `(${col.numeric_precision}`;
            if (col.numeric_scale) {
              type += `,${col.numeric_scale}`;
            }
            type += ')';
          }

          const isPK = primaryKeys.some(pk => pk.column_name === col.column_name);
          const isFK = foreignKeys.some(fk => fk.column_name === col.column_name);
          const isUnique = uniqueConstraints.some(uc => uc.column_name === col.column_name);

          let columnName = col.column_name;
          if (isPK) columnName += ' 🔑';
          if (isFK) columnName += ' 🔗';
          if (isUnique) columnName += ' ✨';

          const nullable = col.is_nullable === 'YES' ? 'YES' : 'NO';
          const defaultValue = col.column_default || '-';

          output += `| ${columnName} | ${type} | ${nullable} | ${defaultValue} | - |\n`;
        });

        output += '\n';

        if (foreignKeys.length > 0) {
          output += '**Foreign Keys:**\n';
          foreignKeys.forEach(fk => {
            output += `- \`${fk.column_name}\` → \`${fk.foreign_table_schema}.${fk.foreign_table_name}.${fk.foreign_column_name}\`\n`;
          });
          output += '\n';
        }

        try {
          const rowCount = await sequelize.query(
            `SELECT COUNT(*) as count FROM "${schemaName}"."${tableName}"`,
            {
              type: QueryTypes.SELECT,
              replacements: { schemaName, tableName }
            }
          );
          output += `**Row Count:** ${rowCount[0]?.count || 0}\n\n`;
        } catch (err) {
          void err;

        }

        output += '---\n\n';
      }
    }

    const outputPath = path.join(__dirname, '..', 'DATABASE_STRUCTURE_AUTO.md');
    fs.writeFileSync(outputPath, output, 'utf8');
    logger.info('Database structure saved', { component: 'generate-db-structure', path: outputPath });

    const mainDocPath = path.join(__dirname, '..', 'DATABASE_STRUCTURE.md');
    const existingContent = fs.existsSync(mainDocPath)
      ? fs.readFileSync(mainDocPath, 'utf8')
      : '';

    const autoGeneratedSection = `<!-- AUTO-GENERATED SECTION - DO NOT EDIT MANUALLY -->\n\n${output}\n\n<!-- END AUTO-GENERATED SECTION -->\n\n`;

    if (existingContent.includes('<!-- AUTO-GENERATED SECTION')) {
      const beforeAuto = existingContent.split('<!-- AUTO-GENERATED SECTION')[0];
      const afterAuto = existingContent.split('<!-- END AUTO-GENERATED SECTION -->')[1] || '';
      fs.writeFileSync(mainDocPath, beforeAuto + autoGeneratedSection + afterAuto, 'utf8');
    } else {
      fs.writeFileSync(mainDocPath, autoGeneratedSection + existingContent, 'utf8');
    }
    logger.info('Main documentation updated', { component: 'generate-db-structure', path: mainDocPath });

  } catch (error) {
    logger.error('Error generating database structure', {
      component: 'generate-db-structure',
      error: error?.message,
      stack: error?.stack
    });
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

generateDatabaseStructure();
