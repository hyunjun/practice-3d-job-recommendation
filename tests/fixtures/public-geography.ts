import type { City } from '../../shared/types'

// Literal geographic inputs for map tests, independent of the product registry
// and historical demo metadata. Coordinates retain the Seattle/Vancouver and
// London/Amsterdam cluster boundaries; descriptive demo copy is not reused.
const rows: [
  string, string, string, string, string, City['region'], number, number, string,
][] = [
  ['san-francisco', '샌프란시스코', 'San Francisco', '미국', 'US', 'americas', 37.7749, -122.4194, 'America/Los_Angeles'],
  ['new-york', '뉴욕', 'New York', '미국', 'US', 'americas', 40.7128, -74.006, 'America/New_York'],
  ['seattle', '시애틀', 'Seattle', '미국', 'US', 'americas', 47.6062, -122.3321, 'America/Los_Angeles'],
  ['austin', '오스틴', 'Austin', '미국', 'US', 'americas', 30.2672, -97.7431, 'America/Chicago'],
  ['boston', '보스턴', 'Boston', '미국', 'US', 'americas', 42.3601, -71.0589, 'America/New_York'],
  ['toronto', '토론토', 'Toronto', '캐나다', 'CA', 'americas', 43.6532, -79.3832, 'America/Toronto'],
  ['vancouver', '밴쿠버', 'Vancouver', '캐나다', 'CA', 'americas', 49.2827, -123.1207, 'America/Vancouver'],
  ['london', '런던', 'London', '영국', 'GB', 'europe', 51.5074, -0.1278, 'Europe/London'],
  ['berlin', '베를린', 'Berlin', '독일', 'DE', 'europe', 52.52, 13.405, 'Europe/Berlin'],
  ['amsterdam', '암스테르담', 'Amsterdam', '네덜란드', 'NL', 'europe', 52.3676, 4.9041, 'Europe/Amsterdam'],
  ['paris', '파리', 'Paris', '프랑스', 'FR', 'europe', 48.8566, 2.3522, 'Europe/Paris'],
  ['dublin', '더블린', 'Dublin', '아일랜드', 'IE', 'europe', 53.3498, -6.2603, 'Europe/Dublin'],
  ['stockholm', '스톡홀름', 'Stockholm', '스웨덴', 'SE', 'europe', 59.3293, 18.0686, 'Europe/Stockholm'],
  ['zurich', '취리히', 'Zurich', '스위스', 'CH', 'europe', 47.3769, 8.5417, 'Europe/Zurich'],
  ['barcelona', '바르셀로나', 'Barcelona', '스페인', 'ES', 'europe', 41.3851, 2.1734, 'Europe/Madrid'],
  ['lisbon', '리스본', 'Lisbon', '포르투갈', 'PT', 'europe', 38.7223, -9.1393, 'Europe/Lisbon'],
  ['singapore', '싱가포르', 'Singapore', '싱가포르', 'SG', 'asia-pacific', 1.3521, 103.8198, 'Asia/Singapore'],
  ['seoul', '서울', 'Seoul', '대한민국', 'KR', 'asia-pacific', 37.5665, 126.978, 'Asia/Seoul'],
  ['tokyo', '도쿄', 'Tokyo', '일본', 'JP', 'asia-pacific', 35.6762, 139.6503, 'Asia/Tokyo'],
  ['sydney', '시드니', 'Sydney', '호주', 'AU', 'asia-pacific', -33.8688, 151.2093, 'Australia/Sydney'],
  ['melbourne', '멜버른', 'Melbourne', '호주', 'AU', 'asia-pacific', -37.8136, 144.9631, 'Australia/Melbourne'],
  ['bengaluru', '벵갈루루', 'Bengaluru', '인도', 'IN', 'asia-pacific', 12.9716, 77.5946, 'Asia/Kolkata'],
]

export const PUBLIC_TEST_CITIES: City[] = rows.map(([id, name, en, country, countryCode, region, lat, lng, timezone]) => ({
  id, name, en, country, countryCode, region, lat, lng, timezone,
  description: `Synthetic protocol geography: ${en}.`,
}))
