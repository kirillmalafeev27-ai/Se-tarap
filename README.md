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


## Russian Guide

- See `DEPLOY_RU.md`
