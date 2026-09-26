const path = require('path');
const express = require('express');
const session = require('express-session');
const { SESSION_SECRET, PORT } = require('../config');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const apiRoutes = require('./routes/api');
const embedBuilderRoutes = require('./routes/embedBuilder');

function startWebServer(client) {
  const app = express();
  app.locals.client = client; // routes read the live bot client off here

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.static(path.join(__dirname, 'static')));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(
    session({
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
      // Note: this uses the default in-memory session store, which resets on
      // every redeploy (same ephemeral-filesystem constraint as everything else
      // on Render's free tier) — logged-in users just need to log in again after
      // a redeploy. Swap in `connect-mongo` here if you want sessions to survive too.
    })
  );

  // UptimeRobot pings this to keep the free Render instance awake 24/7.
  app.get('/health', (req, res) => res.status(200).send('OK'));

  app.get('/', (req, res) => {
    res.render('home', {
      user: req.session?.user || null,
      botTag: client.user?.tag || 'LoofaryBot',
      guildCount: client.guilds.cache.size
    });
  });

  app.use('/auth', authRoutes);
  app.use('/dashboard', dashboardRoutes);
  app.use('/dashboard', embedBuilderRoutes);
  app.use('/api', apiRoutes);

  app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));

  app.listen(PORT, () => console.log(`🌐 Web dashboard & keep-alive server listening on port ${PORT}`));
  return app;
}

module.exports = { startWebServer };
