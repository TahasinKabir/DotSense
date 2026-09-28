# DotSense

Type, speak or scan text → Grade-1 braille → punch it on a GRBL 3018 CNC, and watch the print live.

DotSense 3.0 is the Braille Gcode app, renamed, with the original one-screen layout plus:

- **Live printing over USB** – DotSense talks to the CNC (GRBL) directly. You see each dot as it is punched, the letter, line and cell, % done and time left. Pause, resume and a safe Stop.
- **Auto text** – long text wraps to the paper by itself (lines and pages), and the preview and G-code update while you type or speak.
- **Voice typing** – speak and the words are typed at the cursor. Works offline after a one-time model download.
- **OCR** – read printed text from photos, scans and PDF files (from Braille Gcode 2), offline.
- **Photo from phone** – take a photo with your phone and it comes straight into DotSense over the machine's WiFi (MKS DLC32) and is read. The **WiFi button** in the top right corner shows if the computer is on the machine's WiFi and joins it in one click.
- **Bangla (বাংলা)** – Bangla voice typing, Bangla OCR and Bangla braille (Bangladesh, or India/Bharati), all offline.
- **Invert print** – mirrored punching for reading from the back: “Hello” is punched as O L L E H, each cell flipped. **Invert view** shows the mirrored machine side next to the reading side, both live.

## Run it

1. Install [Node.js](https://nodejs.org) 22 or newer.
2. Extract this ZIP, open a terminal **in the folder with `package.json`**:
   ```
   npm install
   npm start
   ```

The first `npm start` downloads the Electron runtime (about 100 MB) once, so it takes a minute.

Try the live view without a machine: `npm run simulator` adds **Simulator (no machine)** to the port list.

## Light and dark mode

The round button at the top right (left of the connection status) switches between **dark mode** (the original DotSense look) and **light mode** (white cards, soft shadows, amber accents). DotSense remembers your choice; the separate Invert view window and the window frame follow it. Until you choose, it follows your system setting. The braille sheet in the preview stays paper-coloured in both.

## Machine setup (read first)

- **Start position = the first dot** (dot 1, top-left of the first letter), in work coordinates (mm). Letters go to **+X**, dots 2/3 and following lines go to **−Y**.
- **Print area** is measured from the start position: width to the right, height downwards. The app shows how many cells and lines fit per sheet and the X/Y range of the dots on each page.
- The default start is now **X 10, Y 135** (the old one-line app used Y 15). Multi-line pages need room below the first line, so set the start Y near the top edge of your paper.
- Z: **Clearance Z** is above the paper, **Punch depth Z** is below it. Set Z0 on the paper surface.
- Every page ends at clearance height and returns to X0 Y0, like the original app.

## Hide the settings

The **Show** switch in the **Paper & Machine** header folds the whole panel away, leaving only the header. Inside it, the **Page** box (paper size, scaling, time between pages) and the **Machine** box (start position, print area, pitches, Z, feed, dwell) each have their own **Show** switch, so you can fold away what you don't need – hidden settings still apply, and **Use paper size** stays in the Page header. The **G-code output** panel has a **Show** switch too; **Copy** and **Save** still work while the G-code is hidden. DotSense remembers all of them.

## Page (paper size)

Under **Paper & Machine → Page**, switch on **Use paper size** and pick the sheet: A4, 10 × 15 cm, 13 × 18 cm, A6, A5, B5, 9 × 13 cm, 13 × 20 cm, 20 × 25 cm, 16:9 wide, 100 × 148 mm, Envelope #10 / DL / C6, Letter, Legal, A3, A3+, A2, B4, B3, or **User-Defined** (type width and height). Choose **Portrait** or **Landscape** and a **Margin** for all sides; the **cm** / **mm** buttons next to it pick the unit you type it in.

DotSense then sets the start position and print area for you (shown dashed, “from paper size”) and centres the text left-right. Set **X/Y zero at the paper's front-left corner** (bottom-left of the page, top edge toward the back of the machine). If the sheet is bigger than the machine can reach (a typical 3018 moves about 300 × 180 mm; once connected DotSense uses your machine's own limits), a warning suggests Landscape or a smaller size.

Switch it off to go back to your own start position and print area – your values are kept.

**Page scaling** sets the braille size, like the scaling in a print dialog:

- **Fit to printer margins** (the standard) – the braille grows or shrinks (50–200 %) so the text fills one sheet inside the margins. With page breaks, each page fits on one sheet. Text too long for one sheet even at 50 % goes on to the next sheets.
- **Reduce to printer margins** – shrinks only when the text does not fit on one sheet; never bigger than 100 %.
- **Custom scale** – your own size, 50–200 % (100 % = your own dot, cell and line pitch). A size too big for the paper is refused.

**Nothing is punched outside the page:** with a paper size, every dot stays on the paper inside the margins, and DotSense checks every dot again before the machine moves – if one were outside, it prints nothing. (It relies on X/Y zero at the paper's front-left corner.)

The line below shows the size and spacing in use. DotSense warns when dots get closer than standard braille (2.5 mm): check that your punch can do that. With Fit and Reduce the size follows the text while you type, so the start position can move – DotSense then clears **I checked the start position…** so you check it again. Your pitches in the settings stay as they are.

**Choose paper size by PDF page size** – when you scan a PDF (**Scan (OCR)…**), DotSense sets the paper size and orientation from the PDF's first page: the listed size if one matches (within 2 mm), otherwise User-Defined.

## Between pages

When you print several pages, DotSense stops after each sheet, beeps, and shows a countdown: **the next page starts by itself after 30 seconds** (change the seconds next to the **Next page starts after** switch, 5 to 3600). In the last 5 seconds it beeps every second. **Continue now** starts at once, **Wait** stops the countdown until you press Continue, **Stop here** ends the job. It only starts if the machine is connected and Idle. Switch it off to always wait for Continue.

Keep your hands away from the punch when the countdown is running.

## Invert print (mirror)

The punch comes down from the top, so the bumps form on the underside. **Invert print** (its own switch, on by default) mirrors the whole page so it reads correctly when you turn the sheet over, left to right:

- letters are punched in reverse order – “Hello” → **O L L E H** – across the full print width, so a short line sits on the right of the sheet (top view) and on the left after turning it over;
- the dots inside every cell are flipped too (1↔4, 2↔5, 3↔6), otherwise letters like d/f or e/i would read wrong.

It applies to live printing, **Save page** and **Save all** (file names end in `_invert`). The preview shows the reading side. The green **Invert view** button (shown while Invert print is on; red **Invert off** when it is off) puts the mirrored machine side on the right, next to the reading side, so you can watch both live while printing – the machine starts each line on the left of the machine side. DotSense remembers whether it is open. The small **↗** above the machine side opens it in its own window too. Turn Invert print off if your machine punches from below.

## Braille preview

The preview shows the page at its real shape. With a paper size it is the sheet itself – A4 looks like A4, landscape looks like landscape – with the margins dashed and every dot exactly where it will be punched. Without a paper size it shows the print area. Letters are shown above the cells when they are big enough to read; hover a cell to see its letter.

**Est. time** is the time for the whole text. While printing it counts down the time left for the job (all pages being printed), corrected by the real speed of the machine, and stops while paused.

## Live printing

1. Plug in the machine, press ⟳, choose its port (usually `COM3` / `ttyUSB0` / `cu.usbserial…`), 115200 baud, **Connect**. Close Candle/UGS first – only one program can use the port.
2. Open **Tool Box** if you need to move the head, set **X/Y zero** at your paper corner and **Z zero** on the paper. **Go to start position** moves above the start position at clearance height, to check alignment. The jog **Step** is 0.1, 1 or 10 in **mm** or **cm** (cm moves ten times further; Z moves at most 10 mm per click, and no move is longer than the machine's travel). **Unlock** clears an ALARM lock ($X). **Soft Reset** (Ctrl+X) resets the GRBL controller without switching the machine power off – use it if GRBL is stuck, a job needs to be aborted, or you need to reset the controller. It works during a print too and aborts it at once (all remaining pages as well); **Stop** is the gentle way (hold, reset, lift the punch). A reset while the machine moves can leave GRBL in ALARM: press **Unlock**, lift the punch with Z+ and check the position before printing again. **Check Mode** ($C) switches GRBL's check mode on and off, to test G-code without physically moving the CNC: while it is on (the button is highlighted and the status shows *Check mode*), **Print** runs the page through GRBL's G-code checker – no safety tick needed, no sheet changes between pages, nothing moves or is punched – and reports any G-code errors. Switching it off makes GRBL reset itself; then the machine moves normally again.
3. Tick **I checked the start position…**, then **Print page N** or **Print all pages**.
4. While printing: dark dots are punched, the pulsing dot is the current one. **Pause** is a GRBL feed hold. **Stop** does feed hold → soft reset (keeps position) → lifts the punch to clearance.
5. With several pages, DotSense stops after each sheet so you can put in the next one at the same place; the next page starts by itself after the countdown (see Between pages).

Text and settings are locked while printing. Stay near the machine and its power switch – software stop is not an emergency stop.

## Voice typing

Press **Voice typing**. The first time, choose a model to download (once, from the sherpa-onnx GitHub releases):

- **Accurate · 111 MB** – best for accented English and voice commands (recommended).
- **Fast · 30 MB** – smaller and quicker, less accurate.

Then speak; words appear at the cursor and the braille updates. Say **"new line"**, **"new paragraph"** or **"new page"** on their own. Speech never leaves the computer. On macOS allow microphone access when asked.

**Bangla:** pick **বাংলা** next to Voice typing (the same switch sets the Scan language). The first time, DotSense offers **Download Bangla · 87 MB** – an offline Bangla speech model (Vosk small streaming Bengali, Apache-2.0, via sherpa-onnx). Bangla voice commands: **"নতুন লাইন"**, **"নতুন অনুচ্ছেদ"**, **"নতুন পাতা"** (also "নতুন পৃষ্ঠা", "নতুন পেজ"). The voice model list in the voice bar has **বাংলা · 87 MB** too.

## OCR (images and PDF)

**Scan (OCR)…** or drop files on the window. PNG, JPG, BMP, WebP and PDF; English or Bangla printed text (**Language: English / বাংলা** in the dialog, the same switch as in the Text panel; Bangla also reads English words); runs offline (the English and Bangla data are included). In Bangla every PDF page is read with OCR, because the text stored in Bangla PDFs usually comes out scrambled. Choose **Replace** or **Add after** the current text, a PDF page range, **OCR every PDF page** for scans, and optionally a new braille sheet per source page. Camera photos stored sideways (turned by a note in the file, as phones do) are turned upright before reading. Always read the text after scanning.

## Machine WiFi and Photo from phone

The **WiFi button in the top right corner** shows whether this computer is on the machine's WiFi – the MKS DLC32 board's own network **MKS_DLC** (password **12345678**): green **Connected** or red **Not connected**. When it is red, **one click joins it** – no questions. (On Windows the network is kept as "connect manually", so it never takes over your internet by itself.) Click the green button for the details or to change the name and password; **Default name and password** puts back MKS_DLC / 12345678. On the machine's WiFi the computer has no internet unless a cable is plugged in – pick your usual WiFi in the system WiFi menu to go back. Printing still uses the USB cable.

**Photo from phone** is in **Scan (OCR)…**. Press **Use phone camera**, then:

1. Put the phone on the same WiFi. For MKS_DLC, choose **Phone WiFi** under the code and scan it with the phone camera – the phone joins the machine's WiFi (needed once).
2. Choose **Camera page** and scan the code with the phone camera (or type the address shown under it).
3. Tap **Take photo** (or **Choose from gallery**). The photo appears in the Scan window and its text goes into the text box – nothing to click on the computer.

The first photo follows **Put the text** (Replace / Add after); the next ones are added after it. If Scan is closed, a photo opens it and is always added after your text. Click a small photo to see it large. The phone page shows **Connected to PC** and **On your PC ✓** for each photo; the phone sends each photo upright and at most 3200 pixels on its long side, so it crosses the WiFi quickly.

The link stays on – also after DotSense restarts – until you press **Stop**, and its address stays the same, so the phone page can stay open (or be bookmarked). Only that secret link works, only photos are accepted (up to 25 MB), and nothing is saved on the computer.

If the phone cannot open the page:

- **Windows Firewall** asks the first time: allow DotSense and tick **Public networks** too (a new WiFi such as MKS_DLC counts as public).
- Phone and computer must be on the same WiFi. **Android** on the machine's WiFi (it has no internet): turn mobile data off, and choose to stay connected when the phone asks.
- If the phone still cannot reach the computer on MKS_DLC, put both on your usual WiFi instead: Photo from phone works on any shared WiFi, and the code always shows the computer's current address.
- **Windows 11** tells apps the WiFi name only when **Location** is on (Settings › Privacy & security › Location, also "Let desktop apps access your location"). Without it DotSense reads the name from the network list; if that fails the button shows **WiFi ?** – connecting still works.

## Braille rules

Grade-1 (uncontracted) English: A–Z, digits with the number sign (and the letter sign when a–j follows a number), and `, ; : . ! ? ' -`. Capitals are not marked. Curly quotes become `'`, long dashes become `-`. Other characters are listed in a warning and punched as blank cells. `[[PAGE]]` or **Page break** starts a new sheet.

**Bangla braille** (Bharati braille; choose **Bangla braille: Bangladesh / India (Bharati)** in Paper & Machine, Bangladesh by default). English and Bangla can be mixed in one text.

- Vowels and vowel signs share cells (আ / া ⠜, ই / ি ⠊ …); consonants as in the Bengali Braille tables; ং ⠰, ঃ ⠠, ঁ ⠄, ঽ ⠂, । ⠲.
- Bangladesh and India differ in খ (⠭ / ⠨), ঝ (⠵ / ⠴), ভ (⠧ / ⠘), ঢ় (⠷ / ⠐⠻) and ৎ (⠐⠞ / ⠈⠞).
- Halant (্) is written **before** the consonant it kills: ধর্ম = ⠮⠈⠗⠍. ক্ষ ⠟ and জ্ঞ ⠱ have their own cells; ড় ⠻, য় ⠢.
- A vowel letter right after a consonant gets the inherent অ (⠁): কই = ⠅⠁⠊ (কি = ⠅⠊).
- Bangla digits (০–৯) use the number sign like English digits; a letter right after a number gets the letter sign ⠰.
- The G-code comments are ASCII, so Bangla is written there in Latin letters (e.g. `; TEXT: AAMAARA SONAARA BAANGLAA`).

Sources: Wikipedia “Bengali Braille” (Bangladesh and India tables), liblouis `bengali.cti` (Braille Council of India) and the *Standard Bharati Braille Codes*. Please have a braille reader check your first Bangla pages.

## Files

Save the current page as `.gcode`, all pages as a ZIP, or a DotSense project (`.json` with text and settings). Braille Gcode 2 projects open too.

## Build an installer

```
npm run dist
```
Builds for the OS you run it on (`.exe` on Windows, `.dmg` on macOS, `.AppImage` on Linux), in `dist/`.

## Tests

```
npm test
```
Checks braille layout (same dot positions as the original app for one-line text), Bangla braille (both standards), wrapping and pages, paper sizes and page scaling (Fit / Reduce pick the largest size that fits), invert print (turning the punched sheet over gives exactly the normal braille), G-code, the GRBL streamer against a simulated GRBL (buffer never overflows, pause, stop, alarms, errors, unplug, GRBL 0.9), voice model unpacking, the WiFi status on Windows, macOS and Linux, and the phone link (secret address, photos only, size limit, QR codes).

## Troubleshooting

- **Port busy / Access denied** – close Candle, UGS or Arduino IDE.
- **No ports listed (Windows)** – install the CH340 USB driver for your board.
- **Linux: Permission denied** – `sudo usermod -a -G dialout $USER`, then log out and in.
- **No reply from GRBL** – check the baud rate (115200 for GRBL 1.1) and the USB cable.
- **ALARM** – check the machine, then **Unlock**. After a limit alarm set zero again.
- **Phone cannot open the page** – see Machine WiFi and Photo from phone.

## Code

- `core.js` – braille translation (English and Bangla), auto-wrap, page layout, G-code, time estimate
- `renderer.js`, `index.html`, `styles.css` – the main window (`theme.js` sets light or dark mode before the window is drawn)
- `invert.html`, `invert.js` – the machine side in its own window (↗)
- `grbl.js` – GRBL streaming, status, live progress, pause/stop
- `fake-grbl.js` – GRBL simulator for tests and `npm run simulator`
- `main.js`, `preload.js` – Electron main process, files, OCR, serial port
- `voice-worker.js`, `voice-models.js`, `capture-worklet.js` – offline voice typing (English and Bangla)
- `wifi.js` – this computer's WiFi: status and one-click join (netsh / networksetup / nmcli)
- `phone-server.js`, `phone-page.html` – Photo from phone: the small web server, QR codes and the phone's camera page

---

Footer logos: `brand/linkedin.png` and `brand/github.png` (replace them to change; without them the footer uses simple icons).

Developed by **Tahasin Kabir Rubai** · © 2026 · [GitHub](https://github.com/TahasinKabir) · [LinkedIn](https://www.linkedin.com/in/tahasin-kabir)
