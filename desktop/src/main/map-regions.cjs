// Offline province/city/district selection. Source and license: map-regions.LICENSE.txt.
const regions = require('../shared/map-regions.json');
function validateMapRegion(city, district = '', province = '') {
  const normalize = value => String(value || '').trim().replace(/市$/, '');
  const choices = regions.filter(p => !province || p.name === province).flatMap(p => p.cities);
  const found = choices.find(c => normalize(c.name) === normalize(city));
  if (!found) throw Error('请选择具体城市，不能将省份作为城市；请通过“换地区”重新选择。');
  if (district && !found.districts.includes(district)) throw Error('区县与城市不匹配，请通过“换地区”重新选择。');
}
module.exports = { validateMapRegion };
