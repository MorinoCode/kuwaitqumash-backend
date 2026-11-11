import * as whatsappService from '../../utils/whatsapp.service.js';
import WhatsappConfig from '../platform/whatsapp.config.model.js';
import Customer from '../customers/customer.model.js';
import sequelize from '../../config/database.js';
import { Op, QueryTypes } from 'sequelize';
import { normalizePhone } from '../../utils/phone.utils.js';
import logger from '../../utils/logger.js';

export const getStatus = async (req, res) => {
  try {
    const branchId = req.query.branch_id ? parseInt(req.query.branch_id, 10) : null;
    const status = await whatsappService.getSessionStatus(req.tenant.slug, branchId);
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error("WhatsApp Error", { component: 'whatsapp.controller', error: error?.message, stack: error?.stack });
    res.status(500).json({ message: 'Failed to process request. Please try again.' });
  }
};

export const connect = async (req, res) => {
  const tenantSlug = req.tenant.slug;
  const branchId = req.query.branch_id ? parseInt(req.query.branch_id, 10) : null;
  let ended = false;
  const log = (msg, ctx = {}) => logger.info(msg, { component: 'whatsapp.controller', tenantSlug, branchId, ...ctx });
  const logErr = (msg, ctx = {}) => logger.error(msg, { component: 'whatsapp.controller', tenantSlug, branchId, ...ctx });

  log('connect SSE start');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const sendEvent = (type, data) => {
    if (ended) return;
    try {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
      log('SSE sent', { type });
    } catch (e) {
      logErr('SSE write error', { type, error: e?.message });
    }
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    try { 
      res.end(); 
    } catch (endError) {
      logErr('Failed to end SSE response', { error: endError?.message });
    }
    log('connect SSE finish');
  };

  sendEvent('connecting', { message: 'Waiting for QR...' });
  req.on('close', () => {
    log('connect SSE req close');
    finish();
  });

  try {
    await whatsappService.connectToWhatsApp(tenantSlug, (event) => {
      try {
        if (event.type === 'qr') {
          sendEvent('qr', event.data);
        } else if (event.type === 'restarting') {
          sendEvent('restarting', event.data || 'Linking device…');
        } else if (event.type === 'connected') {
          const uid = event.user?.id;
          const phone = typeof uid === 'string' ? uid.split(':')[0] : '';
          sendEvent('connected', { phone: phone || '', name: event.user?.name || '' });
          finish();
        } else if (event.type === 'closed') {
          sendEvent('closed', event.data || 'Connection closed.');
          finish();
        } else if (event.type === 'error') {
          sendEvent('error', event.data || 'Connection failed.');
          finish();
        }
      } catch (e) {
        logErr('connect callback error', { eventType: event?.type, error: e?.message });
        sendEvent('error', e?.message || 'Connection error.');
        finish();
      }
    }, { branchId });
    log('connectToWhatsApp returned');
  } catch (error) {
    logErr('connect error', { error: error?.message, stack: error?.stack });
    sendEvent('error', error?.message || 'Connection failed.');
    finish();
  }
};

export const disconnect = async (req, res) => {
  try {
    const branchId = req.query.branch_id ? parseInt(req.query.branch_id, 10) : null;
    const success = await whatsappService.logoutWhatsApp(req.tenant.slug, branchId);
    if (success) {
      res.json({ success: true, message: 'Disconnected successfully.' });
    } else {
      res.status(400).json({ message: 'Failed to disconnect.' });
    }
  } catch (error) {
    logger.error("WhatsApp Error", { component: 'whatsapp.controller', error: error?.message, stack: error?.stack });
    res.status(500).json({ message: 'Failed to process request. Please try again.' });
  }
};

export const updateSettings = async (req, res) => {
  try {
    const { is_enabled, owner_phone, manager_phone } = req.body;
    
    let config = await WhatsappConfig.findOne({ where: { tenant_slug: req.tenant.slug } });
    
    if (!config) {
      config = await WhatsappConfig.create({
        tenant_slug: req.tenant.slug,
        is_enabled,
        owner_phone,
        manager_phone
      });
    } else {
      await config.update({ is_enabled, owner_phone, manager_phone });
    }

    res.json({ success: true, message: 'Settings updated.', data: config });
  } catch (error) {
    logger.error("WhatsApp Error", { component: 'whatsapp.controller', error: error?.message, stack: error?.stack });
    res.status(500).json({ message: 'Failed to process request. Please try again.' });
  }
};

export const getSettings = async (req, res) => {
  try {
    const config = await WhatsappConfig.findOne({ where: { tenant_slug: req.tenant.slug } });
    res.json({ success: true, data: config || {} });
  } catch (error) {
    logger.error("WhatsApp Error", { component: 'whatsapp.controller', error: error?.message, stack: error?.stack });
    res.status(500).json({ message: 'Failed to process request. Please try again.' });
  }
};

/** POST /whatsapp/bulk — send message to segmented customers. store_owner only. */
export const sendBulk = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { segment, branch_id, message, delay_ms } = req.body;
    const tenantSlug = req.tenant.slug;
    
    // Check WhatsApp connection status before starting
    // If branch_id is provided, check branch-level connection
    // If not provided, try tenant-level first, then fallback to any branch connection
    let branchIdForCheck = branch_id ? parseInt(branch_id, 10) : null;
    let waStatus = await whatsappService.getSessionStatus(tenantSlug, branchIdForCheck);
    
    // If tenant-level not connected and no branch_id provided, try to find any connected branch
    if (!branchIdForCheck && (waStatus.status !== 'CONNECTED' && !waStatus.is_ready)) {
      try {
        // Try to find any connected branch
        const Branch = sequelize.models.Branch;
        const branches = await Branch.schema(schema).findAll({ attributes: ['id'], limit: 50 });
        
        for (const branch of branches) {
          const branchStatus = await whatsappService.getSessionStatus(tenantSlug, branch.id);
          if (branchStatus.status === 'CONNECTED' || branchStatus.is_ready) {
            branchIdForCheck = branch.id;
            waStatus = branchStatus;
            logger.info('Using branch WhatsApp connection for bulk send', { 
              component: 'whatsapp.controller', 
              tenantSlug, 
              branchId: branchIdForCheck 
            });
            break;
          }
        }
      } catch (branchCheckError) {
        logger.warn('Failed to check branch connections for bulk send', { 
          component: 'whatsapp.controller', 
          tenantSlug, 
          error: branchCheckError?.message 
        });
      }
    }
    
    if (waStatus.status !== 'CONNECTED' && !waStatus.is_ready) {
      return res.status(400).json({ 
        success: false,
        message: `WhatsApp is not connected${branchIdForCheck ? ` for branch ${branchIdForCheck}` : ' (tenant-level)'}. Please connect WhatsApp first.`,
        status: waStatus.status
      });
    }

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const hasPhone = { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] };
    let customers = [];

    if (segment === 'all') {
      const where = { phone: hasPhone };
      if (branch_id) where.branch_id = branch_id;
      customers = await Customer.schema(schema).findAll({ where, attributes: ['id', 'phone'] });
    } else if (segment === 'high_value_6m') {
      const rows = await sequelize.query(
        `SELECT customer_id FROM "${schema}".invoices WHERE created_at >= :sixMonthsAgo GROUP BY customer_id HAVING SUM(total_amount) >= 500`,
        { replacements: { sixMonthsAgo }, type: QueryTypes.SELECT }
      );
      const ids = Array.isArray(rows) ? rows.map((r) => r.customer_id).filter(Boolean) : [];
      if (ids.length === 0) return res.json({ success: true, sent: 0, message: 'No customers match segment.' });
      const where = { id: { [Op.in]: ids }, phone: hasPhone };
      if (branch_id) where.branch_id = branch_id;
      customers = await Customer.schema(schema).findAll({ where, attributes: ['id', 'phone'] });
    } else if (segment === 'inactive_6m') {
      const rows = await sequelize.query(
        `SELECT DISTINCT customer_id FROM "${schema}".invoices WHERE created_at >= :sixMonthsAgo`,
        { replacements: { sixMonthsAgo }, type: QueryTypes.SELECT }
      );
      const activeIds = Array.isArray(rows) ? rows.map((r) => r.customer_id).filter(Boolean) : [];
      const where = { phone: hasPhone };
      if (activeIds.length) where.id = { [Op.notIn]: activeIds };
      if (branch_id) where.branch_id = branch_id;
      customers = await Customer.schema(schema).findAll({ where, attributes: ['id', 'phone'] });
    } else if (segment === 'last_30d') {
      const rows = await sequelize.query(
        `SELECT DISTINCT customer_id FROM "${schema}".invoices WHERE created_at >= :since`,
        { replacements: { since: thirtyDaysAgo }, type: QueryTypes.SELECT }
      );
      const ids = Array.isArray(rows) ? rows.map((r) => r.customer_id).filter(Boolean) : [];
      if (ids.length === 0) return res.json({ success: true, sent: 0, message: 'No customers match segment.' });
      const where = { id: { [Op.in]: ids }, phone: hasPhone };
      if (branch_id) where.branch_id = branch_id;
      customers = await Customer.schema(schema).findAll({ where, attributes: ['id', 'phone'] });
    } else if (segment === 'last_90d') {
      const rows = await sequelize.query(
        `SELECT DISTINCT customer_id FROM "${schema}".invoices WHERE created_at >= :since`,
        { replacements: { since: ninetyDaysAgo }, type: QueryTypes.SELECT }
      );
      const ids = Array.isArray(rows) ? rows.map((r) => r.customer_id).filter(Boolean) : [];
      if (ids.length === 0) return res.json({ success: true, sent: 0, message: 'No customers match segment.' });
      const where = { id: { [Op.in]: ids }, phone: hasPhone };
      if (branch_id) where.branch_id = branch_id;
      customers = await Customer.schema(schema).findAll({ where, attributes: ['id', 'phone'] });
    } else if (segment === 'vip_only') {
      const where = { phone: hasPhone, type: 'VIP' };
      if (branch_id) where.branch_id = branch_id;
      customers = await Customer.schema(schema).findAll({ where, attributes: ['id', 'phone'] });
    }

    const phones = [...new Set(customers.map((c) => normalizePhone(c.phone || '')))].filter(Boolean);
    if (phones.length === 0) {
      return res.json({ success: true, sent: 0, message: 'No phones to send to.' });
    }

    let sent = 0;
    const delay = Math.max(500, Math.min(60000, Number(delay_ms) || 3000));
    const sentPhones = [];
    const failedPhones = [];

    logger.info('Bulk WhatsApp send started', {
      component: 'whatsapp.controller',
      tenantSlug,
      branchId: branch_id,
      segment,
      totalPhones: phones.length,
      messageLength: message.length
    });

    // Use branch-specific WhatsApp if branch_id is provided, otherwise use the found connection
    const branchIdForSend = branch_id ? parseInt(branch_id, 10) : branchIdForCheck;
    for (let i = 0; i < phones.length; i++) {
      const phone = phones[i];
      try {
        const ok = await whatsappService.sendWhatsAppText(tenantSlug, phone, message, branchIdForSend);
        if (ok) {
          sent++;
          sentPhones.push(phone);
          logger.info('Bulk WhatsApp sent successfully', {
            component: 'whatsapp.controller',
            tenantSlug,
            branchId: branchIdForSend,
            phone: phone.substring(0, 4) + '****' + phone.substring(phone.length - 2), // Partial phone for privacy
            index: i + 1,
            total: phones.length
          });
        } else {
          failedPhones.push(phone);
          logger.warn('Bulk WhatsApp send failed', {
            component: 'whatsapp.controller',
            tenantSlug,
            branchId: branchIdForSend,
            phone: phone.substring(0, 4) + '****' + phone.substring(phone.length - 2),
            index: i + 1,
            total: phones.length,
            reason: 'sendWhatsAppText returned false'
          });
        }
      } catch (phoneError) {
        failedPhones.push(phone);
        logger.error('Bulk WhatsApp send error for phone', {
          component: 'whatsapp.controller',
          tenantSlug,
          branchId: branchIdForSend,
          phone: phone.substring(0, 4) + '****' + phone.substring(phone.length - 2),
          index: i + 1,
          total: phones.length,
          error: phoneError?.message
        });
      }
      if (i < phones.length - 1) await new Promise((r) => setTimeout(r, delay));
    }

    logger.info('Bulk WhatsApp send completed', {
      component: 'whatsapp.controller',
      tenantSlug,
      branchId: branchIdForSend,
      segment,
      sent,
      failed: failedPhones.length,
      total: phones.length,
      sentCount: sentPhones.length,
      failedCount: failedPhones.length
    });

    res.json({ 
      success: true, 
      sent, 
      total: phones.length,
      failed: failedPhones.length,
      details: {
        sent_count: sentPhones.length,
        failed_count: failedPhones.length
      }
    });
  } catch (error) {
    logger.error('WhatsApp bulk send error', {
      component: 'whatsapp.controller',
      error: error?.message,
      stack: error?.stack,
      requestId: req.requestId
    });
    res.status(500).json({ message: 'Failed to send WhatsApp messages. Please try again.' });
  }
};