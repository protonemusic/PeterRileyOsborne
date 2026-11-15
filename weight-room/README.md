# Weight Room Sign-In

A simple kiosk app for the weight room. Everything requires a login. Students sign up once, then sign in each visit by typing
their name and picking it from a list. An admin page shows who came in, and one **Notify Coaches**
button emails each sport's coaches a list of their athletes who signed in.

- **Kiosk** (`/`): set it up on an iPad at the door.
  - **Sign Up:** first name, last name and current sport.
  - **Sign In:** type part of your name, tap it, tap **Sign In**. The sign-in time is saved.
    Students can change their sport here when seasons change. Signing in twice on the same day
    doesn't create a duplicate.
- **Admin** (`/admin`, staff and admins only):
  - **Sign-ins & Notify:** today's sign-ins (or any day), a preview of each coach's email,
    and the **Notify Coaches** button. Each sign-in is emailed only once, so you can press it
    daily, weekly, or whenever you like.
  - **Sports, Seasons & Coaches:** add sports, give each one season dates, and add coach emails.
    The kiosk only offers sports that are in season today. If none are, it offers all of them.
  - **Students:** fix names or sports, and remove students.
  - **Email History:** what was sent and to whom.
  - **Users** (admins only): add people and choose their role. See below.
  - **My Account:** change your password.

## Accounts and roles

| Role  | Can do |
|-------|--------|
| Admin | Everything, including adding, editing and removing users |
| Staff | Everything except managing users |
| Kiosk | Only the student sign-in screen. Use this for the iPad at the door. It stays logged in for 6 months. |

The first admin account is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` the first time the app
starts. After that, those settings are ignored: add and manage everyone from the **Users** tab.
Staff and admin logins last 14 days.

## Run it

Requires Node.js 22.13 or newer.

```bash
cd weight-room
npm install
cp .env.example .env      # then set ADMIN_EMAIL, ADMIN_PASSWORD (and email settings)
npm start                 # http://localhost:3000  and  http://localhost:3000/admin
npm test
```

Data is stored in a SQLite file at `data/weight-room.db`. Back it up by copying that file.

## Setting up email

Until SMTP settings are filled in, **Notify Coaches** shows a preview and sends nothing.
Any SMTP account works:

- **Gmail / Google Workspace:** turn on 2-step verification, create an
  [App Password](https://myaccount.google.com/apppasswords), then set `SMTP_HOST=smtp.gmail.com`,
  `SMTP_PORT=587`, `SMTP_USER` and `SMTP_PASS`.
- **School email or a sending service** (SendGrid, Mailgun, Postmark…): use the SMTP host,
  port, username and password they give you.

## Hosting on Render

The repo includes a `render.yaml` Blueprint, so you can set it up from a browser (an iPad works).

1. Sign up at [render.com](https://render.com) and connect your GitHub account.
2. Go to **New → Blueprint** and pick this repository (it deploys the `main` branch).
3. Fill in the settings it asks for: `ADMIN_NAME`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` (your
   admin login), plus the email settings (leave them blank for now if you like).
4. Click **Apply**. After a few minutes your app is live at `https://weight-room-xxxx.onrender.com`.
5. Log in there with your admin email and password.

**Automatic deploys:** every time something is merged into `main` that changes the app, GitHub runs
the tests, and once they pass Render deploys the new version on its own. If the tests fail, the
live site stays on the last good version.

Cost: the database lives on a persistent disk, which needs Render's paid **Starter** instance
(about $7/month plus $0.25/month for the 1 GB disk). Render's free tier would erase the data on
every restart. Render backs up the disk daily.

Any other host with a persistent disk works too (Railway, Fly.io, a VPS). Set the variables from
`.env.example`, including `SECURE_COOKIES=true` and `TRUST_PROXY=true` behind https.

On the iPad, open the site in Safari and use **Share → Add to Home Screen** for a full-screen kiosk.
Use **Settings → Accessibility → Guided Access** to lock the iPad to the app.

## Privacy note

Nothing is visible without logging in. On the kiosk iPad, anyone at the door can search student
names, because type-ahead sign-in needs that. A kiosk account can't open the admin page.
