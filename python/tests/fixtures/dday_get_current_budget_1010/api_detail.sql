-- 旧口径：grass_date = (select max(grass_date) from ads_budget_snapshot)
select region, shop_id, current_budget
from ads_budget_snapshot
where grass_date = date_add('day', -1, current_date)
