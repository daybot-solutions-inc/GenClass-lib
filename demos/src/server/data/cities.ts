// Synthetic city index for the search demo (recreated 2026-10-09: the original file was never committed because the
// root .gitignore ignores data/). City names and countries are real places; populations are synthetic but
// plausible (derived deterministically from the name), so results are stable across runs and machines.
// Used by the mock server (worlds/search.ts), the search scenario and the search oracle (test code).

export interface City {
  id: number;
  name: string;
  country: string;
  population: number;
}

// "Name|Country" — about 400 entries. Many share a prefix ("San", "Sal", "Port", "Bra") so short prefixes match
// many cities and longer prefixes narrow quickly, like a real gazetteer.
const RAW = `Aachen|Germany;Aarhus|Denmark;Abidjan|Côte d'Ivoire;Abu Dhabi|UAE;Abuja|Nigeria;Acapulco|Mexico;Accra|Ghana;Adelaide|Australia;Addis Ababa|Ethiopia;Agra|India;Ahmedabad|India;Albuquerque|USA;Alexandria|Egypt;Algiers|Algeria;Alicante|Spain;Almaty|Kazakhstan;Amman|Jordan;Amsterdam|Netherlands;Anchorage|USA;Ankara|Turkey;Antalya|Turkey;Antwerp|Belgium;Athens|Greece;Atlanta|USA;Auckland|New Zealand;Austin|USA;Baghdad|Iraq;Baku|Azerbaijan;Baltimore|USA;Bamako|Mali;Bangalore|India;Bangkok|Thailand;Barcelona|Spain;Bari|Italy;Basel|Switzerland;Beijing|China;Beirut|Lebanon;Belfast|UK;Belgrade|Serbia;Belo Horizonte|Brazil;Bergen|Norway;Berlin|Germany;Bern|Switzerland;Bilbao|Spain;Birmingham|UK;Bogotá|Colombia;Bologna|Italy;Bordeaux|France;Boston|USA;Brasília|Brazil;Bratislava|Slovakia;Bremen|Germany;Brest|France;Brighton|UK;Brisbane|Australia;Bristol|UK;Brno|Czechia;Bruges|Belgium;Brussels|Belgium;Bucharest|Romania;Budapest|Hungary;Buenos Aires|Argentina;Buffalo|USA;Bursa|Turkey;Busan|South Korea;Cairo|Egypt;Calgary|Canada;Cali|Colombia;Cambridge|UK;Canberra|Australia;Cancún|Mexico;Cape Town|South Africa;Caracas|Venezuela;Cardiff|UK;Cartagena|Colombia;Casablanca|Morocco;Charlotte|USA;Chennai|India;Chicago|USA;Chongqing|China;Christchurch|New Zealand;Cincinnati|USA;Cleveland|USA;Cologne|Germany;Colombo|Sri Lanka;Columbus|USA;Copenhagen|Denmark;Córdoba|Argentina;Cork|Ireland;Curitiba|Brazil;Dakar|Senegal;Dallas|USA;Damascus|Syria;Da Nang|Vietnam;Dar es Salaam|Tanzania;Darwin|Australia;Delhi|India;Denver|USA;Detroit|USA;Dhaka|Bangladesh;Doha|Qatar;Dortmund|Germany;Dresden|Germany;Dubai|UAE;Dublin|Ireland;Dundee|UK;Durban|South Africa;Düsseldorf|Germany;Edinburgh|UK;Edmonton|Canada;Eindhoven|Netherlands;El Paso|USA;Essen|Germany;Faro|Portugal;Florence|Italy;Fortaleza|Brazil;Fort Worth|USA;Frankfurt|Germany;Fukuoka|Japan;Galway|Ireland;Gdańsk|Poland;Geneva|Switzerland;Genoa|Italy;Ghent|Belgium;Glasgow|UK;Gothenburg|Sweden;Granada|Spain;Graz|Austria;Guadalajara|Mexico;Guangzhou|China;Guatemala City|Guatemala;Guayaquil|Ecuador;Halifax|Canada;Hamburg|Germany;Hamilton|Canada;Hangzhou|China;Hanoi|Vietnam;Hanover|Germany;Harare|Zimbabwe;Havana|Cuba;Helsinki|Finland;Hiroshima|Japan;Ho Chi Minh City|Vietnam;Hobart|Australia;Hong Kong|China;Honolulu|USA;Houston|USA;Hyderabad|India;Indianapolis|USA;Innsbruck|Austria;Istanbul|Turkey;Izmir|Turkey;Jacksonville|USA;Jaipur|India;Jakarta|Indonesia;Jeddah|Saudi Arabia;Jerusalem|Israel;Johannesburg|South Africa;Kabul|Afghanistan;Kampala|Uganda;Kansas City|USA;Karachi|Pakistan;Kathmandu|Nepal;Kaunas|Lithuania;Kazan|Russia;Kharkiv|Ukraine;Khartoum|Sudan;Kigali|Rwanda;Kingston|Jamaica;Kinshasa|DR Congo;Kobe|Japan;Kolkata|India;Kraków|Poland;Kuala Lumpur|Malaysia;Kuwait City|Kuwait;Kyiv|Ukraine;Kyoto|Japan;Lagos|Nigeria;Lahore|Pakistan;La Paz|Bolivia;Las Palmas|Spain;Las Vegas|USA;Lausanne|Switzerland;Leeds|UK;Leipzig|Germany;Lille|France;Lima|Peru;Linz|Austria;Lisbon|Portugal;Liverpool|UK;Ljubljana|Slovenia;Łódź|Poland;London|UK;Los Angeles|USA;Louisville|USA;Luanda|Angola;Lusaka|Zambia;Luxembourg|Luxembourg;Lviv|Ukraine;Lyon|France;Madrid|Spain;Málaga|Spain;Malmö|Sweden;Managua|Nicaragua;Manaus|Brazil;Manchester|UK;Manila|Philippines;Maputo|Mozambique;Maracaibo|Venezuela;Marrakesh|Morocco;Marseille|France;Medellín|Colombia;Melbourne|Australia;Memphis|USA;Mendoza|Argentina;Mexico City|Mexico;Miami|USA;Milan|Italy;Milwaukee|USA;Minneapolis|USA;Minsk|Belarus;Mombasa|Kenya;Monterrey|Mexico;Montevideo|Uruguay;Montpellier|France;Montreal|Canada;Moscow|Russia;Mumbai|India;Munich|Germany;Muscat|Oman;Nagoya|Japan;Nairobi|Kenya;Nantes|France;Naples|Italy;Nashville|USA;Nassau|Bahamas;New Orleans|USA;New York|USA;Newcastle|UK;Nice|France;Nicosia|Cyprus;Nottingham|UK;Novosibirsk|Russia;Nuremberg|Germany;Oakland|USA;Odesa|Ukraine;Oklahoma City|USA;Omaha|USA;Osaka|Japan;Oslo|Norway;Ottawa|Canada;Oxford|UK;Palermo|Italy;Palma|Spain;Panama City|Panama;Paris|France;Perth|Australia;Philadelphia|USA;Phnom Penh|Cambodia;Phoenix|USA;Pittsburgh|USA;Plovdiv|Bulgaria;Porto|Portugal;Porto Alegre|Brazil;Portland|USA;Port Elizabeth|South Africa;Port Louis|Mauritius;Port of Spain|Trinidad and Tobago;Portsmouth|UK;Port Moresby|Papua New Guinea;Poznań|Poland;Prague|Czechia;Pretoria|South Africa;Puebla|Mexico;Pune|India;Quebec City|Canada;Quito|Ecuador;Rabat|Morocco;Raleigh|USA;Recife|Brazil;Reykjavík|Iceland;Riga|Latvia;Rio de Janeiro|Brazil;Riyadh|Saudi Arabia;Rome|Italy;Rosario|Argentina;Rotterdam|Netherlands;Sacramento|USA;Saint Petersburg|Russia;Salamanca|Spain;Salt Lake City|USA;Salta|Argentina;Salvador|Brazil;Salzburg|Austria;Samara|Russia;San Antonio|USA;San Diego|USA;San Francisco|USA;San José|Costa Rica;San Jose|USA;San Juan|Puerto Rico;San Salvador|El Salvador;San Sebastián|Spain;Santa Cruz|Bolivia;Santa Fe|USA;Santander|Spain;Santiago|Chile;Santo Domingo|Dominican Republic;Santos|Brazil;São Paulo|Brazil;Sapporo|Japan;Sarajevo|Bosnia and Herzegovina;Saratov|Russia;Savannah|USA;Seattle|USA;Sendai|Japan;Seoul|South Korea;Seville|Spain;Shanghai|China;Sheffield|UK;Shenzhen|China;Singapore|Singapore;Skopje|North Macedonia;Sofia|Bulgaria;Southampton|UK;Split|Croatia;St. Louis|USA;Stockholm|Sweden;Strasbourg|France;Stuttgart|Germany;Surabaya|Indonesia;Sydney|Australia;Taipei|Taiwan;Tallinn|Estonia;Tampa|USA;Tampere|Finland;Tangier|Morocco;Tashkent|Uzbekistan;Tbilisi|Georgia;Tehran|Iran;Tel Aviv|Israel;The Hague|Netherlands;Thessaloniki|Greece;Tianjin|China;Tijuana|Mexico;Tirana|Albania;Tokyo|Japan;Toledo|Spain;Toronto|Canada;Toulouse|France;Tripoli|Libya;Tucson|USA;Tunis|Tunisia;Turin|Italy;Turku|Finland;Ulaanbaatar|Mongolia;Utrecht|Netherlands;Valencia|Spain;Valladolid|Spain;Valparaíso|Chile;Vancouver|Canada;Venice|Italy;Verona|Italy;Vienna|Austria;Vientiane|Laos;Vilnius|Lithuania;Vladivostok|Russia;Warsaw|Poland;Washington|USA;Wellington|New Zealand;Windhoek|Namibia;Winnipeg|Canada;Wrocław|Poland;Wuhan|China;Xi'an|China;Yangon|Myanmar;Yerevan|Armenia;Yokohama|Japan;Zagreb|Croatia;Zanzibar|Tanzania;Zaragoza|Spain;Zürich|Switzerland;Santa Barbara|USA;Santa Marta|Colombia;Santa Clara|Cuba;Sant Cugat|Spain;Salinas|USA;Salerno|Italy;Saltillo|Mexico;Samsun|Turkey;Sanaa|Yemen;Bremerhaven|Germany;Brampton|Canada;Brandon|Canada;Braga|Portugal;Brașov|Romania;Bridgetown|Barbados;Marbella|Spain;Maribor|Slovenia;Mariupol|Ukraine;Marsala|Italy;Martinique|France;Porvoo|Finland;Potsdam|Germany;Poitiers|France;Ponce|Puerto Rico;Pondicherry|India;Brisbane Valley|Australia;Portimão|Portugal;Portoviejo|Ecuador;Port Harcourt|Nigeria;Port Hedland|Australia`;

/** FNV-1a: stable synthetic populations. */
function h(s: string): number {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x;
}

export const CITIES: readonly City[] = RAW.split(";").map((row, i) => {
  const [name, country] = row.split("|");
  const v = h(name) / 0xffffffff;
  // 40k .. ~20M, log-uniform-ish
  const population = Math.round(Math.exp(10.6 + v * 6.2) / 100) * 100;
  return { id: i + 1, name, country, population };
});

/** Strip accents and case so "sao" finds "São Paulo". */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

const FOLDED = CITIES.map((c) => ({ c, name: fold(c.name), words: fold(c.name).split(/[\s'-]+/) }));

/** Max items in one answer (the UI shows "top N" when more match). */
export const PAGE = 8;

/**
 * Prefix search on the whole name or any word in it; the best matches first (whole-name prefix, then population).
 * Pure and deterministic: the oracle calls it with the input text to know the right list.
 */
export function searchCities(q: string): { total: number; items: City[] } {
  const f = fold(q);
  if (!f) return { total: 0, items: [] };
  const hits = FOLDED.filter((e) => e.name.startsWith(f) || e.words.some((w) => w.startsWith(f)));
  hits.sort((a, b) => {
    const pa = a.name.startsWith(f) ? 0 : 1;
    const pb = b.name.startsWith(f) ? 0 : 1;
    return pa - pb || b.c.population - a.c.population || a.c.id - b.c.id;
  });
  return { total: hits.length, items: hits.slice(0, PAGE).map((e) => e.c) };
}

/** Cities the scripted users type (long enough that prefixes overlap with other cities). */
export const TYPED_TARGETS: readonly string[] = [
  "Santiago",
  "Portland",
  "Brisbane",
  "Salvador",
  "Marseille",
  "San Francisco",
  "Barcelona",
  "Bratislava",
  "Porto Alegre",
  "Santa Cruz",
  "Salzburg",
  "Manchester",
  "Melbourne",
  "Montreal",
  "Stockholm",
  "Bremen",
  "Marrakesh",
  "Port Louis",
  "Copenhagen",
  "Saint Petersburg",
];
