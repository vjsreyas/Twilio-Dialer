# Dialer (Twilio browser cold-calling)

Call leads from your laptop browser through Twilio. One lead at a time, you press Call, you talk, you log the outcome.
No auto-dialing, no AI voice, no recording.

## Setup (about 45 minutes)

### 1. Twilio console
1. Upgrade the account (add card, add ~$20 credit). Trial accounts can only call verified numbers.
2. Phone Numbers > Buy a number: US, local, Voice-capable. This is your caller ID.
3. Account > API keys & tokens > Create API key (Standard). Copy the `SK...` SID and the secret now (shown once).
4. Voice > Manage > TwiML Apps > Create. Voice Request URL: `https://YOUR-HTTPS-URL/voice`, method POST. Copy the `AP...` SID.
5. Voice > Settings > Geo permissions: enable **United States and Canada only**. Disable everything else.
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
- Put your own number in `TEST_NUMBERS` (e.g. `+91...`) and temporarily enable that country in Geo permissions. Import it as a lead, call it. Remove both after testing.
- Check: audio both ways, hang up, outcome saved, Export log works.

## Rules built in
- Dials only numbers imported as leads. The server rechecks everything on every call.
- Blocked: Caribbean, US territories, premium and Alaska area codes.
- Calling window 9am to 8pm in the lead's local time (from state or timezone column).
- No call-count limits by default (set DAILY_CAP_PER_NUMBER or MONTHLY_CAP_PER_NUMBER in .env if you ever want one). Do-not-call outcome blocks the number permanently.
- Max call length 15 minutes. Password lockout after 5 bad tries.

## Before you ramp up (not optional)
- Telemarketing to businesses: still scrub against the National DNC list and state lists, and honor opt-outs immediately. Check state rules (e.g. FL, OK, TX, others have their own).
- Trust Hub: register a Business Profile, SHAKEN/STIR, CNAM and Voice Integrity, or your calls will show as spam.
- Start at 5 to 10 calls/day and watch answer rates before scaling. Use one real human voice. Say who you are in the first sentence.
- Never expose `/api/token` or `/voice` without the checks in this app. Open dialers get used for toll fraud.

## CSV format
`name,company,phone,state,timezone,notes` (state like TX; timezone optional, e.g. America/Chicago).
Download the template from the app.

Estimated cost: about $0.014/min outbound plus $0.004/min browser leg, plus $1.15/month for the number.

## Guest test link (temporary, saves nothing)

Lets someone else make one test call from their own browser, without seeing your leads or password.

1. Sign in, click **Guest link**, enter the number they should call (international format, e.g. +447123456789).
2. Set how long the link lasts, how many calls, and the max seconds per call. Click **Create guest link**; the link is copied.
3. Send them the link. They open it, allow the microphone, and press **Start test call**.

The guest can only call the number you entered. Links live in memory only: they disappear after expiry, when you click **Revoke**, or when the server restarts. Twilio still keeps its own call log for any call.
