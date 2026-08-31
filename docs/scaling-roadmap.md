# Scaling Roadmap

## Free now

Everything in Phases 1–9 runs at £0/month.

| Service | Free allowance | Reality for one cellar |
|---|---|---|
| Supabase | 500 MB DB, 50k MAU, **2 active projects** | A cellar is kilobytes |
| Netlify | **300 credits/month** | See the warning below |
| GitHub | Unlimited private repos, `github.dev` editor | Sufficient |
| Tooling | Vite, React, TypeScript, Vitest, Zod — all open source | — |
| Natural Earth | Public domain | No licence fee |

### Netlify credits — the real constraint

Netlify Free is credit-based, not bandwidth-based. **300 credits per month,
hard limit, no rollover, no auto-recharge.**

- A **production deploy costs 15 credits** → about **20 published deploys/month**
- Bandwidth is 20 credits/GB → roughly 15 GB
- **Deploy previews and branch deploys cost 0 credits**

Work on branches, preview freely, publish deliberately.

### Supabase — two active projects

The free plan allows two active projects. V2 and V3 both fit. Paused projects
do not count toward the limit, so allowing V2 to pause frees headroom.

Free projects pause after 7 days idle. The daily `ping()` prevents this.

## Paid when scaling

Needed for a commercial product, not for personal use.

| Need | Trigger | Cost |
|---|---|---|
| Supabase Pro | Free tier has **zero backup retention** | $25/mo per org — verified |
| Netlify Personal | Beyond ~20 deploys/month | $9/mo, 1,000 credits — verified |
| Object storage | Bottle photographs | Usage-based |
| AI recognition | Photo → identified wine | Not verified — will check when relevant |
| AI enrichment | Auto-fill region, grapes, window | Not verified |
| Market valuation | Live pricing feeds | Commercial licensing, expensive |
| Error monitoring | Knowing about crashes first | Sentry free tier likely sufficient |
| Legal | UK GDPR controller duties for client data | Requires proper advice |

Figures marked *not verified* are deliberately not estimated.

## The backup gap

Supabase free tier has **no backups at all**. Current protection:

1. Server database
2. Device cache on each signed-in device
3. Manual JSON export

That is adequate for personal use. For client data, Pro's daily backups stop
being optional.
