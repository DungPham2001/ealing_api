/**
 * Public content is maintained by EALING (spec 3.10): the company profile and the list of downloadable templates.
 *   npm run content -- company path/to/company.json
 *   npm run content -- templates path/to/templates.json
 * Without a file it prints what is served now.
 */
const fs = require('fs');
const mongoose = require('mongoose');
const config = require('../src/config');
const { getCompany, getTemplates, putContent } = require('../src/services/content');

async function main() {
  const [id, file] = process.argv.slice(2);
  if (!['company', 'templates'].includes(id)) throw new Error('usage: npm run content -- company|templates [file.json]');
  await mongoose.connect(config.mongoUri);
  if (file) await putContent(id, JSON.parse(fs.readFileSync(file, 'utf8')));
  console.log(JSON.stringify(id === 'company' ? await getCompany() : await getTemplates(), null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
