const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');

async function main() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri);
  const server = app.listen(config.port, () => console.log(`Ealing Holdings API on :${config.port} (${config.env}) db=${mongoose.connection.name}`));
  const shutdown = () => server.close(() => mongoose.disconnect().then(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
