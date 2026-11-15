# Weight Room Sign-In

A simple kiosk app for the weight room. Students sign up once, then sign in each visit by typing
their name and picking it from a list. An admin page shows who came in, and one **Notify Coaches**
button emails each sport's coaches a list of their athletes who signed in.

- **Kiosk** (`/`): set it up on an iPad at the door.
  - **Sign Up:** first name, last name and current sport.
  - **Sign In:** type part of your name, tap it, tap **Sign In**. The sign-in time is saved.
    Students can change their sport here when seasons change. Signing in twice on the same day
    doesn't create a duplicate.
- **Admin** (`/admin`, password protected):
  - **Sign-ins & Notify:** today's sign-ins (or any day), a preview of each coach's email,
    and the **Notify Coaches** button. Each sign-in is emailed only once, so you can press it
    daily, weekly, or whenever you like.
  - **Sports, Seasons & Coaches:** add sports, give each one season dates, and add coach emails.
    The kiosk only offers sports that are in season today. If none are, it offers all of them.
  - **Students:** fix names or sports, and remove students.
  - **Email History:** what was sent and to whom.

## Run it

Requires Node.js 22.13 or newer.

```bash
cd weight-room
npm install
cp .env.example .env      # then set ADMIN_PASSWORD (and email settings)
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

## Hosting

Any host that runs Node.js **and keeps files on a persistent disk** works, because the database
is a file. Examples: Render (add a persistent disk and point `DATABASE_FILE` at it), Railway
(with a volume), Fly.io (with a volume), or a small VPS. Set the variables from `.env.example`
in the host's settings. Once it's on `https://`, set `SECURE_COOKIES=true`.

On the iPad, open the site in Safari and use **Share → Add to Home Screen** for a full-screen kiosk.
Use **Settings → Accessibility → Guided Access** to lock the iPad to the app.

## Privacy note

The sign-in page lets anyone using the kiosk search student names. That's needed for type-ahead
sign-in, but it means the kiosk URL should not be posted publicly. Everything else is behind the
admin password.
