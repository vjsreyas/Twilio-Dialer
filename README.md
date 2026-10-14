# Dialer (Twilio browser cold-calling)

Call leads from your laptop browser through Twilio. One lead at a time, you press Call, you talk, you log the outcome.
No auto-dialing, no AI voice, no recording.

## Setup (about 45 minutes)

### 1. Twilio console
1. Upgrade the account (add card, add ~$20 credit). Trial accounts can only call verified numbers.
2. Phone Numbers > Buy a number: US, local, Voice-capable. This is your caller ID.
3. Account > API keys & tokens > Create API key (Standard). Copy the `SK...` SID and the secret now (shown once).
4. Voice > Manage > TwiML Apps > Create. Voice Request URL: `https://YOUR-HTTPS-URL/voice`, method POST. Copy the `AP...` SID.
5. Voice > Settings > Geo permissions: enable only the countries you call (e.g. UK, US/Canada, India). Disable everything else.
6. Copy your Account SID and Auth Token from the console home (the Auth Token validates that /voice requests really come from Twilio).

### 2. This app
```
cp .env.example .env     # fill in every value
npm install
npm start
```
Open http://localhost:3000 and sign in with APP_PASSWORD. Chrome or Edge, allow the microphone.

### 3. Make it reachable by Twilio
Twilio must reach `/voice` over https.
- Quick: `npx cloudflared tunnel --url http://localhost:3000` (or ngrok). The URL changes on each restart, so update the TwiML App Voice URL each time.
- Later: deploy on a small VPS with a fixed domain. Keep `data.json` on a persistent disk (free tiers like Render's wipe it).

### 4. Test before real leads
Add your own number as a lead and call it. Check: audio both ways, hang up, outcome saved, the call shows in the Call log with its talk time.

## How it works
- **Any country.** Every number is accepted. Numbers written without a `+` get the default country you pick on the Leads tab (e.g. `07700 900123` with United Kingdom becomes `+447700900123`).
- **Twilio Geo permissions are the real limit.** Enable only the countries you call (Voice > Settings > Geo permissions), or calls to them fail. This is also your protection against toll fraud if the app password leaks.
- **Leads:** name and phone are required; company, country, email and notes are optional. The server only dials numbers saved as leads.
- **Bulk add:** paste cells from Google Sheets / Excel, paste a CSV, or type `Name, Number` one per line. The app finds the Name and Phone columns from the header (any order, extra columns ignored, title rows above the header are fine) and shows what will be imported and what will be skipped, with reasons, before anything is saved. Excel files: save as CSV or copy/paste the cells.
- **After each call:** an optional note (email, follow-up details) and one outcome: No answer, Hung up, Not interested, Potential, Meeting booked.
- **Call log tab:** every call with Twilio's line result (answered / no answer / busy) and billed talk time, filters, editable outcome and notes, CSV export.
- **Clocks:** UK, US (pick the zone) and India time in the header.
- Max call length defaults to 4 hours (Twilio's limit); set `MAX_CALL_SECONDS` to lower it. Password lockout after 5 bad tries.

## Before you ramp up
- Telemarketing rules differ by country (UK TPS/CTPS, US National DNC, etc.). Scrub your lists and honour opt-outs.
- Trust Hub: register a Business Profile, SHAKEN/STIR, CNAM and Voice Integrity, or your calls will show as spam.

Cost depends on the destination country (see Twilio's voice pricing page), plus about $0.004/min for the browser leg and the monthly number fee.

## Guest test link (temporary, saves nothing)

Lets someone else make one test call from their own browser, without seeing your leads or password.

1. Sign in, click **Guest link**, enter the number they should call (international format, e.g. +447123456789).
2. Set how long the link lasts, how many calls, and the max seconds per call. Click **Create guest link**; the link is copied.
3. Send them the link. They open it, allow the microphone, and press **Start test call**.

The guest can only call the number you entered. Links live in memory only: they disappear after expiry, when you click **Revoke**, or when the server restarts. Twilio still keeps its own call log for any call.
