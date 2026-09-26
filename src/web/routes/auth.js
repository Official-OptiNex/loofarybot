const express = require('express');
const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = require('../../config');

const router = express.Router();

router.get('/discord', (req, res) => {
  if (!CLIENT_SECRET || !REDIRECT_URI) {
    return res.status(500).render('error', {
      message: 'OAuth2 login is not configured. Set CLIENT_SECRET and REDIRECT_URI in your environment.'
    });
  }
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds'
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

router.get('/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/auth/discord');

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const tokenData = await tokenRes.json();

    const [userRes, guildsRes] = await Promise.all([
      fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      }),
      fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      })
    ]);
    if (!userRes.ok || !guildsRes.ok) throw new Error('Failed to fetch user info from Discord.');

    req.session.user = await userRes.json();
    req.session.guilds = await guildsRes.json();

    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth2 callback error:', err);
    res.status(500).render('error', { message: 'Login failed. Please try again.' });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
