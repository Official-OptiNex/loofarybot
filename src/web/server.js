const path = require('path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const { SESSION_SECRET, PORT } = require('../config');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const apiRoutes = require('./routes/api');
const manageRoutes = require('./routes/manage');
const embedBuilderRoutes = require('./routes/embedBuilder');
const botChatRoutes = require('./routes/botChat');
const { siteLocals, botStats, publicCommands } = require('./utils/site');

function startWebServer(client) {
  const app = express();
  // Routes read the live bot client off here. Not named `client`: app.locals are passed to every
  // EJS view, and EJS treats a `client` field as its own option (client-side mode), which breaks include().
  app.locals.discordClient = client;

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

  // Public pages (and the error page) share the site header, so every view gets its data.
  app.use((req, res, next) => {
    Object.assign(res.locals, siteLocals(req));
    next();
  });

  // UptimeRobot pings this to keep the free Render instance awake 24/7.
  app.get('/health', (req, res) => res.status(200).send('OK'));

  app.get('/', (req, res) => {
    res.render('home', { stats: botStats(client), publicCommands: publicCommands() });
  });

  app.use('/auth', authRoutes);
  app.use('/dashboard', dashboardRoutes);
  app.use('/dashboard', embedBuilderRoutes);
  app.use('/dashboard', botChatRoutes);
  app.use('/api', apiRoutes);
  app.use('/api', manageRoutes);

  app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));

  app.listen(PORT, () => console.log(`🌐 Web dashboard & keep-alive server listening on port ${PORT}`));
  return app;
}

module.exports = { startWebServer };
