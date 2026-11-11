# Arabic font for invoice PDF (Amiri)

To display Arabic correctly in generated invoice PDFs, place **Amiri-Regular.ttf** here.

**Option 1 – automatic download (recommended):**
```bash
node scripts/download-amiri-font.js
```

**Option 2 – manual:**
1. Download [Amiri](https://fonts.google.com/specimen/Amiri) from Google Fonts.
2. Extract the ZIP and copy `Amiri-Regular.ttf` into this `fonts` folder.

If the font is missing, invoices still generate but use English-only labels.
