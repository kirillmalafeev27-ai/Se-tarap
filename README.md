# German Sea Trap Online

## Run

1. Install dependencies:
   npm install
2. Set env vars for AITunnel + Gemini:
   - copy `.env.example` values into your environment
   - or set directly in shell
3. Start server:
   npm start
4. Open:
   - Student: `http://localhost:3000/student.html`
   - Teacher: `http://localhost:3000/teacher.html`

## Notes

- Board size is controlled by teacher: 5x5 / 6x6 / 7x7.
- Word container supports pairs `German - Russian` and keeps only German part.
- `Shuffle words on board` shuffles words directly on the field.
- Gemini 2.5 Flash runs through AITunnel from the backend only.
- Required env vars: `AITUNNEL_API_KEY`, `AITUNNEL_BASE_URL`, `GEMINI_MODEL`.

## AITunnel Tutorial

1. Create an API key in AITunnel.
2. Set env vars on the backend:
   - `AITUNNEL_API_KEY=sk-aitunnel-...`
   - `AITUNNEL_BASE_URL=https://api.aitunnel.ru/v1`
   - `GEMINI_MODEL=gemini-2.5-flash`
3. Start the server:
   - `npm start`
4. Open `http://localhost:3000/health` and verify:
   - `aiProvider` = `aitunnel`
   - `aiModel` = `gemini-2.5-flash`
   - `hasApiKey` = `true`
5. Open:
   - Student: `http://localhost:3000/student.html`
   - Teacher: `http://localhost:3000/teacher.html`

### Render Setup

1. Open the service in Render.
2. Go to `Environment`.
3. Add `AITUNNEL_API_KEY` with your `sk-aitunnel-...` key.
4. Add `AITUNNEL_BASE_URL=https://api.aitunnel.ru/v1`.
5. Add `GEMINI_MODEL=gemini-2.5-flash`.
6. Save and redeploy.

## Task Pairing Config (Server-side)

You can configure how the second word is selected for a task via env vars:

- `TASK_SUPPORT_MODE` = `adjacent` | `row` | `column` | `rook` | `global`
- `TASK_FALLBACK_MODE` = fallback mode if no candidate found
- `TASK_NEIGHBOR_RADIUS` = `1..3` (used by `adjacent`)
- `TASK_REQUIRE_DIFFERENT_ARTICLE` = `true`/`false` (tries to avoid same article der/die/das)

Defaults:

- `TASK_SUPPORT_MODE=adjacent`
- `TASK_FALLBACK_MODE=global`
- `TASK_NEIGHBOR_RADIUS=1`
- `TASK_REQUIRE_DIFFERENT_ARTICLE=false`


## Russian Guide

- See `DEPLOY_RU.md`
