'use strict';

const nodemailer = require('nodemailer');

/**
 * Returns { configured, send(message) }.
 * Without SMTP settings, nothing is sent: the app shows a preview instead.
 */
function createMailer(env = process.env) {
  if (!env.SMTP_HOST) {
    return { configured: false, async send() { throw new Error('Email is not configured'); } };
  }
  const port = Number(env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  const from = env.MAIL_FROM || env.SMTP_USER;
  return {
    configured: true,
    async send(message) {
      return transport.sendMail({ from, ...message });
    },
  };
}

module.exports = { createMailer };
