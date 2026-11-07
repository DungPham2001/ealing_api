/** Loads every resource definition (order matters only for readability: refs are resolved by path at runtime). */
require('./structure');
require('./realestate');
require('./operations');
require('./development');
require('./finance');
require('./work');
require('./master');
module.exports = require('../core/registry');
