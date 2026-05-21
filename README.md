# Handpan Webhook Server

Razorpay webhook handler for Handpan with Arpit business dashboard.

## Environment Variables

Set these in Railway:

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (from Replit secrets) |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay webhook secret |
| `PORT` | Set automatically by Railway |

## Endpoints

- `GET /health` — Health check
- `POST /api/webhooks/razorpay` — Razorpay webhook receiver

## Deploy

1. Push this repo to GitHub
2. Connect to Railway
3. Add environment variables
4. Deploy
