# Israel Scraper Desktop - Install Guide (macOS)

---

## English Guide

### 1) Copy the DMG

Use this file from the project:

- `packages/desktop/release/Israel Scraper-0.0.1.dmg`

Transfer it by AirDrop, USB drive, cloud storage, or shared folder.

### 2) Install the app

1. Double-click the DMG file.
2. In the installer window, drag **Israel Scraper.app** to **Applications**.
3. Eject the mounted DMG.

### 3) First launch (Apple security warning)

Because this build is not code-signed/notarized, macOS may block first launch.

1. Open **Applications**.
2. Right-click **Israel Scraper.app**.
3. Click **Open**.
4. In the warning dialog, click **Open** again.

After this first approval, you can launch normally.

### 4) Runtime notes

- The app runs an internal local server on `127.0.0.1:3847`.
- Runtime data is stored in your user data folder (not inside the `.app` bundle).
- Internet access is required for scraping and sending alert emails.

### 5) Troubleshooting

- If the app does not open, repeat the Right-click -> Open flow.
- If macOS still blocks it, go to **System Settings -> Privacy & Security** and allow opening the blocked app.
- If scraping fails, verify connectivity and environment variables.

---

## מדריך התקנה בעברית

### 1) העברת קובץ ה-DMG

השתמש בקובץ הבא מתוך הפרויקט:

- `packages/desktop/release/Israel Scraper-0.0.1.dmg`

אפשר להעביר אותו דרך AirDrop, דיסק און קי, שירות ענן או תיקיה משותפת.

### 2) התקנה

1. לחץ פעמיים על קובץ ה-DMG.
2. בחלון ההתקנה גרור את **Israel Scraper.app** אל **Applications**.
3. הוצא (Eject) את ה-DMG המותקן.

### 3) הפעלה ראשונה (אזהרת אבטחה של Apple)

מכיוון שהגרסה אינה חתומה/מאומתת מול Apple, macOS עלול לחסום פתיחה ראשונה.

1. פתח את **Applications**.
2. לחץ קליק ימני על **Israel Scraper.app**.
3. בחר **Open**.
4. בחלון האזהרה לחץ שוב על **Open**.

אחרי אישור חד-פעמי זה, ניתן לפתוח את האפליקציה כרגיל.

### 4) הערות ריצה

- האפליקציה מריצה שרת מקומי פנימי על `127.0.0.1:3847`.
- נתוני ריצה נשמרים בתיקיית המשתמש (ולא בתוך חבילת האפליקציה).
- נדרשת גישה לאינטרנט לצורך סריקה ושליחת מיילי התראות.

### 5) פתרון תקלות

- אם האפליקציה לא נפתחת, נסה שוב את התהליך: קליק ימני -> Open.
- אם macOS עדיין חוסם, עבור אל **System Settings -> Privacy & Security** ואשר פתיחה.
- אם הסריקה נכשלת, בדוק חיבור רשת ומשתני סביבה נדרשים.
