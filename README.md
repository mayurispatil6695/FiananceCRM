# Finance CRM (Phases 1-2)

Lead management and calling CRM. Runs entirely on your own machine or office server. No cloud services, no external API calls.

## What Phase 1 includes

- Login with roles: **admin**, **manager**, **caller**
- Lead list with search, filters (status, location, score range, date range) and "Today's follow-ups"
- Add / edit leads. Callers can only update status, remarks and follow-up date on leads assigned to them
- Excel/CSV **import with a review screen** (invalid mobiles and duplicates are flagged, rows are editable before saving)
- Excel **export** of the current filtered list

## Phase 2: import from a photo or screenshot

On the **Import** screen you can also upload a JPG/PNG of the vendor's sheet (a phone photo of a monitor works).

- Runs fully offline on the server: `tesseract.js` with the English model bundled from `@tesseract.js-data/eng`. No cloud calls, and the image is held in memory only
- Detects sideways/upside-down photos automatically
- Reads the image three different ways and combines the results (about 30 seconds per image)
- Snaps misspelt places (e.g. "MUMBAL") to known locations; the list grows from locations already in the CRM
- The review screen shows the photo beside the extracted rows. Rows are flagged when a mobile number is invalid, a date differs from most rows, or a location is not recognised
- **Download Excel** on the review screen turns the checked rows straight into an .xlsx file without saving anything in the CRM
- Several users can upload photos at the same time; images are read one after another in a queue (about 30 seconds each), so a user may wait for their turn
- Always compare mobile numbers and income with the photo before saving. OCR on a tilted photo of a screen is good but not perfect; a clean screenshot or the original Excel file is always more accurate

## Requirements

- Node.js 18 or newer
- MongoDB running locally (default `mongodb://127.0.0.1:27017`)

## Setup

```bash
# 1. Backend
cd server
npm install
cp .env.example .env        # then set JWT_SECRET to a long random string
npm run seed                # creates the first admin: admin / admin123
npm run dev                 # API on http://localhost:5000

# 2. Frontend (new terminal)
cd client
npm install
npm run dev                 # app on http://localhost:5173
```

Change the admin password right after first login (API: `POST /api/auth/change-password`; a screen for it comes in the next phase).

## Running for the office (production)

```bash
cd client && npm run build
cd ../server && npm start
```

The server then serves the built app too. Callers open `http://<server-pc-ip>:5000` in their browser over the office network.

## Import file format

First row must be headers. Recognised names (case-insensitive):

| Field | Accepted headers |
|---|---|
| Date | date |
| Mobile (required) | mobile, mob, mobile no, phone, mobile number |
| Name (optional) | name |
| Score | score, cibil, credit score |
| Income | income, salary |
| Location | location, city |

Mobile numbers are cleaned to 10 digits (a leading +91 or 0 is removed) and must start with 6-9.

## Privacy notes

- Uploaded files are held in memory only and are never written to disk
- The database lives on the local machine; take regular backups (e.g. `mongodump` on a schedule to a local drive)
- Do not expose port 5000 to the internet

## Next phases

3. Call history per lead, assignment screens, follow-up reminders
4. Reports, daily backups, audit log
