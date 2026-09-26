const path = require('path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
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
  app.use(express.json({ limit: '8mb' })); // settings imports can include member XP
  app.use(express.urlencoded({ extended: true }));

  // Behind Render's proxy — needed so secure cookies work over HTTPS.
  app.set('trust proxy', 1);
  app.use(
    session({
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, sameSite: 'lax' }, // 7 days
      // Sessions live in MongoDB (reusing the bot's connection) so logins survive redeploys.
      // Expired sessions are removed automatically by a TTL index.
      store: MongoStore.create({
        client: mongoose.connection.getClient(),
        collectionName: 'web_sessions',
        ttl: 60 * 60 * 24 * 7,
        touchAfter: 60 * 60 // only rewrite an unchanged session once an hour
      })
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
