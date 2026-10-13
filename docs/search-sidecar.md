# Search sidecar notes

The entire graph app hydrates identity (especially firm names and individual details) from gzip search-index flatfiles, not from ad-hoc live FINRA/SEC detail calls.

## Files

Source of truth after index build:

- `data/national/search-index.finra.firm.json` & `.json.gz`
- `data/national/search-index.finra.individual.json` & `.json.gz`
- `data/national/search-index.sec.firm.json` & `.json.gz`
- `data/national/search-index.sec.individual.json` & `.json.gz`

Runtime copies:

- `public/search-indexes/search-index.*.json.gz`

Each firm hit includes `firm_id` / `firm_name`, and (when available) `firm_connection_count` from `data/firm-connections/{id}.json` **currentConnections length only** (previous roster is ignored for sizing). Each individual hit includes `ind_crd`, `ind_firstname`, `ind_lastname`, employments, and `ind_connection_count` (unique firms across current/previous employment arrays). Graph expand/search hydrates these onto `node.knownConnectionCount`, which floors `_deg` / `_vizHalf` so node size does not depend only on currently rendered edges.

## Complete CRD Coverage & Hydration Path

1. **Build indexes**: `.local/scripts/build_search_indexes.js`
   - **Multi-source ingestion**: Reads valid detail payloads across `data/national/`, `data/raw/` (including fresh raw imports), and local Redis (when `USE_LOCAL_REDIS=1`).
   - **Lossless preservation**: Automatically loads existing search index records from `data/national/` and `public/search-indexes/` and merges them with incoming records so previously indexed CRDs are never lost.
   - **Richness scoring**: When multiple records exist for the same CRD, richer records (with names, addresses, and employment data) take precedence over bare stubs.
   - **Outputs**: Emits both uncompressed JSON (`data/national/search-index.*.json`) and maximum-compression gzip sidecars (`data/national/search-index.*.json.gz`).
2. **Copy to public**: `.local/scripts/copy-search-indexes.js`
   - Copies `.json.gz` sidecars from `data/national/` to `public/search-indexes/`, automatically chunking files if any exceed deployment size limits.
3. **Runtime consumption**: `src/lib/localSearch.ts` loads the gzip sidecars (never querying Redis for search indexes).
4. **Graph & Dashboard Hydration**: Expand, graph-search, and client append look up CRDs in that sidecar and cache the real name.

Cached names live on the node and in browser `localStorage` key `finra_node_label_cache` so a later merge cannot revert them to a generic label.

## Rebuild + publish (local → commit → deploy)

Vercel cannot rewrite these gzip files at runtime. After cron/gap-scan discoveries land in local Redis (and optionally after pushing details to prod Redis), refresh the shipped sidecars locally:

```bash
# Ages / sizes for national + public copies
pnpm run sidecars:status

# Merge local Redis + disk into data/national, then copy to public/search-indexes
pnpm run sidecars:rebuild
```

Wrapper: `.local/scripts/rebuild_search_sidecars.mjs`

- `--status` — report only (also the default without `--apply`)
- `--apply` — build then copy (what `pnpm run sidecars:rebuild` runs)
- `--build-only` / `--copy-only` — run one stage
- `--no-local-redis` — build without `USE_LOCAL_REDIS=1`

Report written to `.local/tmp/search_sidecar_rebuild_report.json`.

After a successful rebuild:

1. Review `git status` / diff for `public/search-indexes/*` (these are what deploy ships)
2. Commit the public sidecar updates
3. Deploy so production serves the new `public/search-indexes` files

`data/national/search-index.*` is the local build cache and is gitignored (`data/**`). Keep it on disk for lossless merges on the next rebuild; only `public/search-indexes/` needs to be committed.

`pnpm build` / `vercel-build` still run build + copy as part of the production build pipeline; `sidecars:rebuild` is the intentional offline refresh between deploys when Redis has new CRDs.
