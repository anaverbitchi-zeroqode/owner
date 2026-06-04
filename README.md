# Bubble CSV Export Server

Minimal Express server to export data from Bubble Data API as CSV.

## What it provides

- Export endpoint: `POST /api/v1/csv-export`
- Basic Auth protection (`Authorization: Basic ...`)
- Response: downloadable CSV file (`Content-Disposition`)

## Required environment variables

- `BUBBLE_BASE_URL`
- `BUBBLE_API_TOKEN`
- `EXPORT_LOGIN`
- `EXPORT_PASSWORD`

> Export will fail if any required variable is missing.

## Run locally

```bash
npm install
npm start
```

Server runs on `http://localhost:3000` (or `PORT` if set).

## Test export

```bash
npm run export
```

This command:
- starts the local server,
- calls `POST /api/v1/csv-export` with Basic Auth,
- saves the CSV into `data/`,
- stops the server.

## Export request contract

`POST /api/v1/csv-export` expects:

- Basic Auth header with login/password from env
- JSON body:
  - `source.type` (string, Bubble type)
  - `source.filter` (object, optional)  
    Supported suffixes: `_gte`, `_lte`, `_gt`, `_lt`, `_contains`
  - `resolve` (array of `{ path, type, api_type? }`, optional, applies to all columns)
  - `columns` (array of `{ header, path, format?, resolve? }`)
    - `path` uses Bubble Data API display field names in dot notation
    - `resolve` (optional) is an array of `{ path, type, api_type? }` to fetch referenced things for this column only
    - `type` can be a display name; use `api_type` when Bubble Data API type slug is different
  - `options` (object, optional):
    - `file_name` (string, default: `filename`)
    - `enclose_in_quotes` (boolean, default: `false`)
    - `delimiter` (string, default: `,`; supports `,`, `;`, `\\t`, `tab`)
    - `include_header` (boolean, default: `true`)
    - `null_as` (string, default: `""`)
    - `limit` (integer, optional)
    - `timezone` (string, default: `UTC`, IANA timezone, e.g. `America/Toronto`)

Example body:

```json
{
  "source": {
    "type": "Property Management",
    "filter": {
      "payment_date_gte": "2026-06-01",
      "payment_date_lte": "2026-06-30"
    }
  },
  "resolve": [
    { "path": "Unit", "type": "Unit", "api_type": "unit" },
    { "path": "Unit.Location", "type": "Community", "api_type": "community" }
  ],
  "columns": [
    {
      "header": "Suite",
      "path": "Unit.Suite"
    },
    {
      "header": "Address",
      "path": "Unit.Location.Address"
    },
    { "header": "Rental Period", "path": "Rental Period", "format": "MMMM YYYY" }
  ],
  "options": {
    "file_name": "property-management-export",
    "enclose_in_quotes": true,
    "delimiter": ",",
    "include_header": true,
    "null_as": "",
    "limit": 250,
    "timezone": "America/Toronto"
  }
}
```

### Formats

Supported minimal formats:

- `MMMM YYYY`
- `MMMM D, YYYY`
- `us_phone`
- `currency`
- `upper`
- `lower`

Date formats (`MMMM YYYY`, `MMMM D, YYYY`) are rendered using `options.timezone`.

For `path` values, dot notation is used, for example:

- `Unit.Suite`
- `Unit.Location.Address`

## Seed script (optional)

```bash
npm run seed:6000
```
