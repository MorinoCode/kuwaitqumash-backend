# Dashboard Worker

این Worker به صورت جداگانه اجرا می‌شود و وظیفه aggregate کردن داده‌های Dashboard و cache کردن آن‌ها در Redis را بر عهده دارد.

## ویژگی‌ها

- ✅ Nightly aggregation (هر شب ساعت 2 صبح)
- ✅ Hourly aggregation (هر ساعت برای داده‌های امروز)
- ✅ Caching در Redis با TTL مناسب
- ✅ Fallback به Database در صورت عدم دسترسی به Redis
- ✅ استفاده از `buy_price_snapshot` برای محاسبه دقیق profit
- ✅ ترکیب Category + Karat در analytics (مثلاً "انگشتر ۱۸ عیار")

## نصب و راه‌اندازی

### 1. نصب Dependencies

```bash
cd backend
npm install
```

### 2. تنظیم Environment Variables

در فایل `.env` اضافه کنید:

```env
REDIS_URL=redis://localhost:6379
```

اگر Redis ندارید، Worker به صورت خودکار از Database استفاده می‌کند (Fallback).

### 3. اجرای Worker

#### Development:

```bash
npm run worker:dev
```

#### Production:

```bash
npm run worker
```

یا با PM2:

```bash
pm2 start workers/dashboard-worker.js --name dashboard-worker
```

## Deploy روی Render / VPS

### Option 2: Compute Engine

```bash
# Upload worker files
scp -r workers/ user@server:/path/to/app/

# SSH to server
ssh user@server

# Install dependencies
cd /path/to/app
npm install

# Run with PM2
pm2 start workers/dashboard-worker.js --name dashboard-worker
pm2 save
pm2 startup
```

## ساختار Cache Keys

- `dashboard:owner:{tenant_slug}` - Owner Dashboard
- `dashboard:manager:{tenant_slug}:{branch_id}` - Manager Dashboard
- `dashboard:salesman:{tenant_slug}:{user_id}` - Salesman Dashboard

## TTL (Time To Live)

- **Today's Data**: 1 hour (3600 seconds)
- **Weekly Data**: 24 hours (86400 seconds)
- **Monthly Data**: 7 days (604800 seconds)
- **Low Stock Alerts**: 1 hour (3600 seconds)

## Logs

Worker تمام عملیات‌ها را در logger ثبت می‌کند:

```javascript
logger.info("Owner dashboard aggregated", {
  component: "worker",
  tenant: tenant.slug,
});
```

## Troubleshooting

### Redis Connection Failed

اگر Redis در دسترس نباشد، Worker به صورت خودکار از Database استفاده می‌کند. این هیچ مشکلی ایجاد نمی‌کند، فقط performance کمی پایین‌تر می‌شود.

### Worker Not Running

بررسی کنید که:

1. Database connection برقرار باشد
2. Environment variables درست تنظیم شده باشند
3. Dependencies نصب شده باشند

## Performance

- Worker به صورت جداگانه اجرا می‌شود و load روی API server نمی‌آورد
- Data aggregation در background انجام می‌شود
- API endpoints از cache استفاده می‌کنند (fallback به database)

## Monitoring

برای monitoring می‌توانید از PM2 استفاده کنید:

```bash
pm2 status
pm2 logs dashboard-worker
pm2 monit
```
