# German Sea Trap Online

## Run

1. Install dependencies:
   npm install
2. Set env vars (optional Gemini):
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
- Gemini key is stored on backend (`GEMINI_API_KEY`) and never exposed to student page.

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
