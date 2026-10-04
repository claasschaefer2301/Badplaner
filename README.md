# Schaefer Badplaner

Tablet-App für die Badberatung vor Ort: Foto vom jetzigen Bad aufnehmen, Vigour-Ausstattung (clivia V2 / derby V3 / white V4) wählen, mit Google Gemini ein Nachher-Bild erzeugen und den Kostenrahmen zeigen.

- Frontend: `index.html` (statisch, GitHub Pages)
- Backend: Supabase-Projekt „Claude Gehirn“ (Tabellen `bad_*`, Speicher `bad-fotos`, `bad-produktbilder`)
- Edge Function: `supabase/functions/bad-generieren` (Secret `GEMINI_API_KEY`, optional `GEMINI_IMAGE_MODEL`)
