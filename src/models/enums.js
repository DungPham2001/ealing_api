/**
 * Enum values (snake_case) with their Vietnamese labels (spec section 4). `GET /v1/meta` serves this table,
 * and the same arrays drive validation. `labelOf(values, value)` is used by the search index.
 */
const META = {};
const labels = new WeakMap();

function def(name, pairs) {
  const values = pairs.map(([v]) => v);
  labels.set(values, Object.fromEntries(pairs));
  META[name] = pairs.map(([value, label]) => ({ value, label }));
  return values;
}
const labelOf = (values, v) => labels.get(values)?.[v] ?? v;

const E = {};
E.PRIORITY = def('priority', [['urgent', 'Khẩn cấp'], ['high', 'Cao'], ['normal', 'Thường']]);
E.ENTITY_TYPE = def('Entity.type', [['llc', 'LLC'], ['inc', 'Inc.'], ['other', 'Khác']]);
E.ENTITY_PURPOSE = def('Entity.purpose', [['hold_real_estate', 'Nắm giữ BĐS'], ['invest', 'Đầu tư'], ['operate', 'Vận hành'], ['develop', 'Phát triển']]);
E.ENTITY_STATUS = def('Entity.status', [['active', 'Đang hoạt động'], ['suspended', 'Tạm ngừng'], ['dissolved', 'Đã giải thể']]);
E.CLASS_KEY = def('AssetClass.classKey', [['rental_real_estate', 'BĐS cho thuê'], ['land', 'Đất'], ['developing_real_estate', 'BĐS đang phát triển'], ['other_investment', 'Đầu tư khác'], ['cash_equivalent', 'Tiền mặt tương đương']]);
E.CLASS_STATUS = def('AssetClass.status', [['within', 'Trong khoảng'], ['slight', 'Lệch nhẹ'], ['high', 'Lệch nhiều']]);
E.IC_TXN = def('IntercompanyEntry.txnType', [['capital_transfer', 'Chuyển vốn'], ['expense_paid_on_behalf', 'Trả chi phí hộ'], ['shared_cost_allocation', 'Phân bổ chi phí chung'], ['repayment', 'Hoàn trả']]);
E.IC_RECONCILE = def('IntercompanyPair.reconcileStatus', [['match', 'Khớp'], ['mismatch', 'Lệch']]);
E.EXIT_STRATEGY = def('ExitPlan.strategy', [['hold', 'Giữ'], ['refinance', 'Tái tài trợ'], ['sell', 'Bán'], ['renovate_then_sell', 'Cải tạo rồi bán']]);
E.EXIT_STAGE = def('ExitPlan.lifecycleStage', [['new', 'Mới mua'], ['stabilized', 'Ổn định'], ['value_add', 'Tăng giá trị'], ['prep_sale', 'Chuẩn bị bán'], ['sold', 'Đã bán']]);
E.TRIGGER_METRIC = def('ExitPlan.trigger.metric', [['cap_rate', 'Cap rate'], ['ltv', 'LTV']]);
E.TRIGGER_OP = def('ExitPlan.trigger.op', [['gte', '≥'], ['lte', '≤']]);
E.PROPERTY_TYPE = def('Property.type', [['multifamily', 'Nhà ở nhiều căn'], ['single_family', 'Nhà đơn lập'], ['commercial', 'Thương mại'], ['mixed', 'Hỗn hợp'], ['land', 'Đất']]);
E.PROPERTY_STATUS = def('Property.status', [['owned', 'Đang sở hữu'], ['managed', 'Đang quản lý'], ['developing', 'Đang phát triển'], ['selling', 'Đang bán'], ['sold', 'Đã bán']]);
E.DOC_TYPE = def('PropertyRecord.docType', [['title', 'Quyền sở hữu'], ['survey', 'Bản đồ đo đạc'], ['inspection_report', 'Báo cáo kiểm tra'], ['environmental', 'Môi trường'], ['insurance', 'Bảo hiểm'], ['building_permit', 'Giấy phép xây dựng'], ['contractor_contract', 'Hợp đồng nhà thầu'], ['drawings', 'Bản vẽ']]);
E.DOC_STATUS = def('PropertyRecord.status', [['present', 'Có'], ['missing', 'Thiếu'], ['needs_update', 'Cần cập nhật']]);
E.DOC_SUMMARY_STATUS = def('PropertyRecord.summaryStatus', [['complete', 'Đầy đủ'], ['needs_update', 'Cần cập nhật'], ['missing', 'Thiếu']]);
E.UNIT_STATUS = def('Unit.status', [['leased', 'Đang thuê'], ['vacant', 'Trống'], ['vacating', 'Sắp trống'], ['repair', 'Đang sửa chữa'], ['offline', 'Ngừng cho thuê']]);
E.LEASE_STATUS = def('Lease.status', [['upcoming', 'Sắp bắt đầu'], ['active', 'Đang hiệu lực'], ['expiring', 'Sắp hết hạn'], ['expired', 'Hết hạn'], ['renewed', 'Gia hạn'], ['terminated', 'Chấm dứt']]);
E.RENT_STATUS = def('RentCollection.status', [['paid', 'Đã thu đủ'], ['partial', 'Thu một phần'], ['unpaid', 'Chưa thu'], ['overdue', 'Quá hạn']]);
E.FUNNEL_STEP = def('Funnel.step', [['vacant', 'Trống'], ['preparing', 'Đang chuẩn bị'], ['marketing', 'Đang quảng bá'], ['inquiry', 'Có người hỏi'], ['toured', 'Đã cho xem'], ['applied', 'Đã nhận hồ sơ'], ['signed', 'Đã ký']]);
E.WO_CATEGORY = def('WorkOrder.category', [['plumbing', 'Nước'], ['electrical', 'Điện'], ['hvac', 'Điều hòa'], ['appliance', 'Thiết bị'], ['roof', 'Mái'], ['landscape', 'Cảnh quan'], ['fire_safety', 'An toàn cháy'], ['other', 'Khác']]);
E.WO_STATUS = def('WorkOrder.status', [['new', 'Mới'], ['assigned', 'Đã giao'], ['in_progress', 'Đang xử lý'], ['waiting_parts', 'Chờ vật tư'], ['done', 'Hoàn tất'], ['cancelled', 'Hủy']]);
E.PM_FREQ = def('PmSchedule.frequency', [['monthly', 'Hằng tháng'], ['quarterly', 'Quý'], ['semiannual', '6 tháng'], ['annual', 'Năm'], ['seasonal', 'Theo mùa']]);
E.PM_STATUS = def('PmSchedule.status', [['scheduled', 'Đã lên lịch'], ['due', 'Đến hạn'], ['in_progress', 'Đang làm'], ['done', 'Hoàn tất'], ['overdue', 'Quá hạn']]);
E.PM_AREA = def('PmSchedule.area', [['common', 'Khu vực chung']]);
E.VENDOR_STATUS = def('Vendor.status', [['valid', 'Còn hạn'], ['expiring', 'Sắp hết hạn'], ['expired', 'Hết hạn']]);
E.EQUIP_KIND = def('Equipment.kind', [['hvac', 'Điều hòa'], ['water_heater', 'Máy nước nóng'], ['pump', 'Bơm'], ['elevator', 'Thang máy'], ['generator', 'Máy phát điện'], ['kitchen_appliance', 'Thiết bị bếp']]);
E.EQUIP_CONDITION = def('Equipment.condition', [['good', 'Tốt'], ['watch', 'Cần theo dõi'], ['replace', 'Cần thay']]);
E.UTILITY_KIND = def('Utility.kind', [['electric', 'Điện'], ['water', 'Nước'], ['gas', 'Gas'], ['trash', 'Rác'], ['internet', 'Internet']]);
E.UTILITY_STATUS = def('Utility.status', [['normal', 'Bình thường'], ['abnormal_rise', 'Tăng bất thường']]);
E.STORM_LEVEL = def('StormPlan.responseLevel', [['normal', 'Bình thường'], ['preparing', 'Chuẩn bị'], ['in_storm', 'Trong bão'], ['inspecting', 'Đang kiểm tra'], ['damaged', 'Có thiệt hại'], ['recovered', 'Đã khắc phục']]);
E.STORM_PHASE = def('StormPlan.checklist.phase', [['before', 'Trước bão'], ['during', 'Trong bão'], ['after', 'Sau bão']]);
E.SEVERITY = def('Damage.severity', [['minor', 'Nhẹ'], ['moderate', 'Vừa'], ['severe', 'Nặng']]);
E.RENO_STATUS = def('RenovationProject.status', [['planned', 'Dự kiến'], ['permitting', 'Xin phép'], ['in_progress', 'Đang thi công'], ['acceptance', 'Nghiệm thu'], ['done', 'Hoàn thành'], ['paused', 'Tạm dừng']]);
E.INSPECT_CATEGORY = def('Inspection.category', [['roof', 'Mái'], ['structure', 'Kết cấu'], ['electrical', 'Điện'], ['plumbing', 'Nước'], ['hvac', 'Điều hòa'], ['fire_safety', 'An toàn cháy'], ['elevator', 'Thang máy'], ['parking', 'Bãi xe'], ['landscape', 'Cảnh quan']]);
E.INSPECT_RESULT = def('Inspection.result', [['good', 'Tốt'], ['watch', 'Cần theo dõi'], ['urgent_fix', 'Cần sửa gấp']]);
E.DEV_STAGE = def('DevStage', [['land_search', 'Tìm đất'], ['land_purchase', 'Mua đất'], ['zoning', 'Quy hoạch và thủ tục'], ['design', 'Thiết kế'], ['permitting', 'Xin phép'], ['construction', 'Thi công'], ['finishing', 'Hoàn thiện'], ['lease_or_sale', 'Cho thuê hoặc bán']]);
E.DEV_PRODUCT = def('DevelopmentProject.productType', [['multifamily', 'Nhà ở nhiều căn'], ['commercial', 'Thương mại'], ['single_family', 'Nhà đơn lập']]);
E.DEAL_KIND = def('Deal.kind', [['acquisition', 'Mua vào'], ['disposition', 'Bán ra']]);
E.DEAL_STAGE = def('Deal.stage', [['screening', 'Sàng lọc'], ['analysis', 'Phân tích'], ['offer', 'Chào mua'], ['due_diligence', 'Thẩm định'], ['closed', 'Đóng giao dịch'], ['rejected', 'Từ chối']]);
E.DEAL_CHECK_KEY = def('Deal.checklist.key', [['legal_title', 'Pháp lý & quyền sở hữu'], ['building_inspection', 'Kiểm tra công trình'], ['environmental', 'Môi trường'], ['insurance', 'Bảo hiểm'], ['existing_leases', 'Hợp đồng thuê hiện hữu'], ['financials', 'Tài chính']]);
E.CHECK_STATUS = def('Deal.checklist.status', [['todo', 'Chưa làm'], ['doing', 'Đang làm'], ['done', 'Xong']]);
E.CF_DIRECTION = def('CashFlow.direction', [['income', 'Thu'], ['expense', 'Chi']]);
E.CF_CATEGORY = def('CashFlow.category', [['rent', 'Tiền thuê'], ['other_income', 'Thu khác'], ['sale', 'Bán tài sản'], ['interest_income', 'Lãi'], ['property_tax', 'Thuế BĐS'], ['insurance', 'Bảo hiểm'], ['utilities', 'Tiện ích'], ['repairs_maintenance', 'Sửa chữa & bảo trì'], ['professional_fees', 'Phí chuyên gia'], ['management_fee', 'Phí quản lý'], ['loan_interest', 'Lãi vay'], ['other_corporate', 'Chi phí doanh nghiệp khác']]);
E.CF_INCOME_CATEGORIES = ['rent', 'other_income', 'sale', 'interest_income'];
E.EXPENSE_TYPE = def('CashFlow.expenseType', [['operating', 'Vận hành'], ['capex', 'Vốn hóa']]);
E.RATE_TYPE = def('Loan.rateType', [['fixed', 'Cố định'], ['floating', 'Thả nổi']]);
E.LOAN_STATUS = def('Loan.status', [['current', 'Đang trả'], ['maturing', 'Sắp đáo hạn'], ['paid_off', 'Đã tất toán']]);
E.INCOME_GROUP = def('IncomeEntry.group', [['rent', 'Tiền thuê'], ['other', 'Thu khác'], ['interest', 'Lãi']]);
E.INCOME_SOURCE = def('IncomeEntry.source', [['auto', 'Tự động'], ['manual', 'Thủ công']]);
E.TARGET_SCOPE = def('RevenueTarget.scope', [['month', 'Tháng'], ['quarter', 'Quý'], ['year', 'Năm']]);
E.CLOSE_STEP = def('MonthEndClose.step.key', [['rent_entered', 'Nhập tiền thuê'], ['expenses_entered', 'Nhập chi phí'], ['intercompany_reconciled', 'Đối chiếu nội bộ'], ['loan_balance_updated', 'Cập nhật dư nợ'], ['portfolio_value_updated', 'Cập nhật giá trị danh mục'], ['utilities_checked', 'Kiểm tra tiện ích'], ['budget_reviewed', 'Rà soát ngân sách']]);
E.CLOSE_STATUS = def('MonthEndClose.status', [['todo', 'Chưa làm'], ['doing', 'Đang làm'], ['done', 'Xong'], ['locked', 'Đã chốt kỳ']]);
E.STEP_STATUS = def('MonthEndClose.step.status', [['todo', 'Chưa làm'], ['doing', 'Đang làm'], ['done', 'Xong']]);
E.QUEUE_TYPE = def('QueueItem.type', [['maintenance', 'Bảo trì'], ['due_diligence', 'Thẩm định'], ['lease_renewal', 'Gia hạn hợp đồng'], ['vacant_unit', 'Đơn vị trống'], ['loan_maturity', 'Khoản vay sắp đáo hạn'], ['closing', 'Đóng sổ'], ['storm', 'Ứng phó bão'], ['warranty_expiring', 'Bảo hành sắp hết'], ['pm_due', 'Bảo trì phòng ngừa đến lịch'], ['manual', 'Thủ công']]);
E.QUEUE_STATUS = def('QueueItem.status', [['waiting', 'Chờ'], ['claimed', 'Đã nhận'], ['in_progress', 'Đang xử lý'], ['paused', 'Tạm dừng'], ['done', 'Xong']]);
E.TASK_STATUS = def('Task.status', [['todo', 'Chưa làm'], ['doing', 'Đang làm'], ['done', 'Xong']]);
E.PARTNER_KIND = def('Partner.kind', [['lender', 'Bên cho vay'], ['broker', 'Môi giới'], ['insurer', 'Công ty bảo hiểm'], ['title_insurer', 'Bảo hiểm quyền sở hữu'], ['seller', 'Bên bán'], ['buyer', 'Bên mua'], ['investment_partner', 'Đối tác đầu tư']]);
E.PARTNER_STATUS = def('Partner.status', [['active', 'Đang hoạt động'], ['paused', 'Tạm dừng']]);
E.PROVIDER_KIND = def('ServiceProvider.kind', [['accounting', 'Kế toán'], ['legal', 'Luật sư'], ['advisor', 'Cố vấn'], ['property_management', 'Quản lý tài sản'], ['bank', 'Ngân hàng']]);
E.PROVIDER_STATUS = def('ServiceProvider.status', [['active', 'Đang hiệu lực'], ['expiring', 'Sắp hết hạn'], ['ended', 'Đã kết thúc']]);
E.SCENARIO_TOOL = def('Scenario.toolId', [['acq', 'Phân tích mua'], ['loan', 'Tính khoản vay'], ['refi', 'So sánh tái tài trợ'], ['dev', 'Khả thi dự án'], ['lease', 'Tốc độ lấp đầy'], ['exit', 'Điểm thoái vốn'], ['stress', 'Độ nhạy'], ['reserve', 'Quỹ dự phòng']]);
E.SCENARIO_TARGET = def('Scenario.target.kind', [['deal', 'Giao dịch'], ['development_project', 'Dự án phát triển'], ['exit_plan', 'Kế hoạch thoái vốn']]);
E.REPORT_PERIOD = def('Report.period', [['month', 'Tháng'], ['quarter', 'Quý'], ['year', 'Năm']]);

/** Scenario `ratios`: allowed keys per tool and the range of each (spec 3.8). Money-sized numbers are refused. */
const pctKey = [0, 100];
const yearKey = [0, 100];
const signedPct = [-100, 100];
const count = [0, 100000];
E.SCENARIO_RATIOS = {
  acq: { vac: pctKey, opex: pctKey, ltv: pctKey, rate: pctKey, term: yearKey },
  loan: { rate: pctKey, term: yearKey },
  refi: { r0: pctKey, y0: yearKey, r1: pctKey, y1: yearKey, fee: pctKey },
  dev: { soft: pctKey, cap: pctKey },
  lease: { units: count, vac: count, rate: count, target: pctKey },
  exit: { cost: pctKey },
  stress: { rent: signedPct, vac: signedPct, cost: signedPct, rate: signedPct },
  reserve: { roofL: yearKey, hvacL: yearKey, liftL: yearKey },
};

module.exports = { E, META, labelOf };
