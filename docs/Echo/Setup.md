# Echo setup (Theseus on your Amazon Echo)

Theseus speaks its alerts on your Echo through **Voice Monkey**, and answers "Alexa, ask Theseus …" through an Alexa
skill that it serves on this PC. **Tailscale Funnel** gives the skill the public HTTPS address Alexa needs. Only the
paths `/alexa` (the skill) and `/alexa/a/<random>.mp3` (short-lived audio) are reachable from outside.

## A. Voice Monkey (the announcements)
1. Sign up at voicemonkey.io (the free plan is enough).
2. In the Alexa app: Skills → "Voice Monkey" → Enable, and link your account.
3. In the Voice Monkey console, under Devices, add a device for your Echo and note its name. Under Settings / API, copy the API token.
4. In Theseus: Audio Settings → Echo: paste the token (Save) and type the device name.

## B. Tailscale (the public address)
1. Install Tailscale and sign in.
2. In the Tailscale admin console → DNS: turn on MagicDNS and HTTPS certificates. Allow Funnel for this PC when asked.
3. In Theseus (Audio Settings → Echo), turn **Amazon Echo** on. Theseus sets up the Funnel itself and shows the skill address (`https://<pc>.<tailnet>.ts.net/alexa`). Copy it.

## C. The Alexa skill ("Alexa, ask Theseus who needs me")
1. developer.amazon.com/alexa/console/ask → Create Skill → name "Theseus", English (US), Custom, "Provision your own".
2. Build → Interaction Model → JSON Editor → paste `interaction_model.json` (this folder) → Save → Build.
3. Endpoint → HTTPS → Default region: the skill address from B3. Certificate: "My development endpoint is a sub-domain of a domain that has a wildcard certificate".
4. Copy "Your Skill ID" (amzn1.ask.skill.…) into Audio Settings → Echo → Alexa skill id.
5. Test tab → turn on "Development". The skill now works on Echos signed in to the same Amazon account.

## Try it
- Audio Settings → Echo → **Announce**: the Echo says "This is Theseus on your Echo".
- "Alexa, ask Theseus who needs me" · "Alexa, ask Theseus what <session> is doing".
- After a good test, **Replace the old EchoStatus hook** (only shown while the old hook is still in Claude's settings.json).
