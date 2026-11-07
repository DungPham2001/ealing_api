/**
 * Public content (spec 3.10): company profile and downloadable templates. EALING maintains it outside the app
 * (`npm run content`); the app only reads. Figures in `scale` are shown only when EALING marked them approved,
 * leaders only when they agreed to be public, and nothing is ever derived from the shared business data.
 */
const { Content } = require('../models/system');
const { today } = require('../lib/dates');

const DEFAULT_COMPANY = {
  name: 'EALING, LLC',
  address: '5785 SW 118th St, Coral Gables, FL 33156-5748, United States',
  phone: '+1 662 856 9899',
  email: null, website: null, hours: null,
  field: 'Quản lý và đầu tư tài sản, bất động sản (Holding & Real Estate)',
  foundedYear: 2016,
  headcount: null,
  scale: null,
  operatingAreas: ['Miami-Dade, Florida'],
  licenses: [], values: [], process: [], history: [{ year: 2016, text: 'Thành lập EALING, LLC tại Florida' }], leadership: [],
  equalHousingBadge: true,
  updatedAt: '2026-11-01T00:00:00Z',
};

const DEFAULT_TEMPLATES = [
  ['due_diligence_checklist', 'Checklist thẩm định'], ['month_end_close', 'Mẫu đóng sổ cuối tháng'], ['seasonal_maintenance', 'Lịch bảo trì theo mùa'], ['storm_response_plan', 'Kế hoạch ứng phó bão'],
  ['unit_handover', 'Bàn giao đơn vị'], ['property_records_list', 'Danh sách hồ sơ tài sản'], ['annual_budget_forecast', 'Ngân sách năm / dự báo'], ['glossary', 'Thuật ngữ'],
].map(([key, title]) => ({ key, title, version: '1.0', updatedAt: '2026-11-01', downloadUrl: null }));

async function getCompany() {
  const stored = (await Content.findById('company').lean())?.data || {};
  const c = { ...DEFAULT_COMPANY, ...stored };
  const { approved, ...scale } = c.scale || {};
  return {
    name: c.name, address: c.address, phone: c.phone, email: c.email, website: c.website, hours: c.hours, field: c.field,
    foundedYear: c.foundedYear, yearsActive: c.foundedYear ? Number(today().slice(0, 4)) - c.foundedYear : null,
    headcount: c.headcount, scale: approved ? scale : null,
    operatingAreas: c.operatingAreas, licenses: c.licenses, values: c.values, process: c.process, history: c.history,
    leadership: (c.leadership || []).filter((l) => l.public === true).map(({ public: _p, ...l }) => ({ photoUrl: null, ...l })),
    equalHousingBadge: !!c.equalHousingBadge, updatedAt: c.updatedAt,
  };
}

async function getTemplates() {
  return (await Content.findById('templates').lean())?.data || DEFAULT_TEMPLATES;
}

async function putContent(id, data) {
  await Content.updateOne({ _id: id }, { $set: { data, updatedAt: new Date() } }, { upsert: true });
}

module.exports = { getCompany, getTemplates, putContent, DEFAULT_COMPANY, DEFAULT_TEMPLATES };
