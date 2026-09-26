import type { Company, Job, SavedJob } from '../../shared/types'
import { ADDED_PUBLIC_REGISTRATIONS, EXPANDED_PUBLIC_REGISTRATIONS, ORIGINAL_PUBLIC_REGISTRATIONS, coverageGreenhouseRaw, coveragePresenceResponses, publicCoverageResponses } from './public-coverage'
import { expansionLegacy36Cache, expansionResponses } from './public-company-expansion'
import { coverageReply } from './public-coverage-transport'

// Literal approved registration facts. Every posting, paragraph, native ID
// and application URL is fictional. No production function builds an oracle.
export const SURVEY_REGISTRATIONS = [
  {"id":"adyen","name":"Adyen","careerUrl":"https://careers.adyen.com/","provider":"greenhouse","board":"adyen"},
  {"id":"affirm","name":"Affirm","careerUrl":"https://www.affirm.com/careers","provider":"greenhouse","board":"affirm"},
  {"id":"automattic","name":"Automattic","careerUrl":"https://automattic.com/work-with-us/","provider":"greenhouse","board":"automatticcareers"},
  {"id":"brave","name":"Brave","careerUrl":"https://brave.com/careers/","provider":"greenhouse","board":"brave"},
  {"id":"brex","name":"Brex","careerUrl":"https://www.brex.com/careers","provider":"greenhouse","board":"brex"},
  {"id":"canonical","name":"Canonical","careerUrl":"https://canonical.com/careers","provider":"greenhouse","board":"canonical"},
  {"id":"clickhouse","name":"ClickHouse","careerUrl":"https://clickhouse.com/company/careers","provider":"ashby","board":"ClickHouse"},
  {"id":"cockroachlabs","name":"Cockroach Labs","careerUrl":"https://www.cockroachlabs.com/careers/","provider":"greenhouse","board":"cockroachlabs"},
  {"id":"cohere","name":"Cohere","careerUrl":"https://cohere.com/careers","provider":"ashby","board":"cohere"},
  {"id":"confluent","name":"Confluent","careerUrl":"https://careers.confluent.io/","provider":"ashby","board":"confluent"},
  {"id":"coupang","name":"Coupang","careerUrl":"https://www.coupang.jobs/en/","provider":"greenhouse","board":"coupang"},
  {"id":"cursor","name":"Cursor","careerUrl":"https://www.cursor.com/careers","provider":"ashby","board":"cursor"},
  {"id":"delivery-hero","name":"Delivery Hero","careerUrl":"https://careers.deliveryhero.com/","provider":"smartrecruiters","board":"DeliveryHero"},
  {"id":"digitalocean","name":"DigitalOcean","careerUrl":"https://www.digitalocean.com/careers","provider":"greenhouse","board":"digitalocean98"},
  {"id":"docker","name":"Docker","careerUrl":"https://www.docker.com/careers/","provider":"ashby","board":"docker"},
  {"id":"elastic","name":"Elastic","careerUrl":"https://www.elastic.co/careers","provider":"greenhouse","board":"elastic"},
  {"id":"elevenlabs","name":"ElevenLabs","careerUrl":"https://elevenlabs.io/careers","provider":"ashby","board":"elevenlabs"},
  {"id":"epicgames","name":"Epic Games","careerUrl":"https://www.epicgames.com/site/en-US/careers","provider":"greenhouse","board":"epicgames"},
  {"id":"fivetran","name":"Fivetran","careerUrl":"https://www.fivetran.com/careers","provider":"greenhouse","board":"fivetran"},
  {"id":"grafana","name":"Grafana Labs","careerUrl":"https://grafana.com/careers/","provider":"greenhouse","board":"grafanalabs"},
  {"id":"kong","name":"Kong","careerUrl":"https://konghq.com/careers","provider":"ashby","board":"kong"},
  {"id":"lyft","name":"Lyft","careerUrl":"https://www.lyft.com/careers","provider":"greenhouse","board":"lyft"},
  {"id":"miro","name":"Miro","careerUrl":"https://miro.com/careers/","provider":"greenhouse","board":"realtimeboardglobal"},
  {"id":"mozilla","name":"Mozilla","careerUrl":"https://www.mozilla.org/en-US/careers/","provider":"greenhouse","board":"mozilla"},
  {"id":"n26","name":"N26","careerUrl":"https://n26.com/en-eu/careers","provider":"greenhouse","board":"n26"},
  {"id":"okta","name":"Okta","careerUrl":"https://www.okta.com/company/careers/","provider":"greenhouse","board":"okta"},
  {"id":"palantir","name":"Palantir","careerUrl":"https://www.palantir.com/careers/","provider":"lever","board":"palantir"},
  {"id":"perplexity","name":"Perplexity","careerUrl":"https://www.perplexity.ai/hub/careers","provider":"ashby","board":"perplexity"},
  {"id":"plaid","name":"Plaid","careerUrl":"https://plaid.com/careers/","provider":"ashby","board":"plaid"},
  {"id":"posthog","name":"PostHog","careerUrl":"https://posthog.com/careers","provider":"ashby","board":"posthog"},
  {"id":"proton","name":"Proton","careerUrl":"https://proton.me/careers","provider":"greenhouse","board":"proton"},
  {"id":"ramp","name":"Ramp","careerUrl":"https://ramp.com/careers","provider":"ashby","board":"ramp"},
  {"id":"replit","name":"Replit","careerUrl":"https://replit.com/careers","provider":"ashby","board":"replit"},
  {"id":"riotgames","name":"Riot Games","careerUrl":"https://www.riotgames.com/en/work-with-us","provider":"greenhouse","board":"riotgames"},
  {"id":"runway","name":"Runway","careerUrl":"https://runwayml.com/careers","provider":"ashby","board":"runway-ml"},
  {"id":"scaleai","name":"Scale AI","careerUrl":"https://scale.com/careers","provider":"greenhouse","board":"scaleai"},
  {"id":"sentry","name":"Sentry","careerUrl":"https://sentry.io/careers/","provider":"ashby","board":"sentry"},
  {"id":"servicenow","name":"ServiceNow","careerUrl":"https://careers.servicenow.com/","provider":"smartrecruiters","board":"ServiceNow"},
  {"id":"snowflake","name":"Snowflake","careerUrl":"https://careers.snowflake.com/","provider":"ashby","board":"snowflake"},
  {"id":"temporal","name":"Temporal","careerUrl":"https://temporal.io/careers","provider":"ashby","board":"temporal"},
  {"id":"togetherai","name":"Together AI","careerUrl":"https://www.together.ai/careers","provider":"greenhouse","board":"togetherai"},
  {"id":"twilio","name":"Twilio","careerUrl":"https://www.twilio.com/en-us/company/jobs","provider":"greenhouse","board":"twilio"},
  {"id":"twitch","name":"Twitch","careerUrl":"https://www.twitch.tv/jobs/","provider":"greenhouse","board":"twitch"},
  {"id":"waymo","name":"Waymo","careerUrl":"https://waymo.com/careers/","provider":"greenhouse","board":"waymo"},
  {"id":"wikimedia","name":"Wikimedia Foundation","careerUrl":"https://wikimediafoundation.org/about/jobs/","provider":"greenhouse","board":"wikimedia"},
  {"id":"xai","name":"xAI (SpaceXAI)","careerUrl":"https://x.ai/careers","provider":"greenhouse","board":"xai"},
  {"id":"zoox","name":"Zoox","careerUrl":"https://zoox.com/careers/","provider":"lever","board":"zoox"},
] satisfies Pick<Company, 'id' | 'name' | 'careerUrl' | 'provider' | 'board'>[]

export const SURVEY_FULL_URLS: Record<string, string> = {
  "adyen": "https://boards-api.greenhouse.io/v1/boards/adyen/jobs?content=true&pay_transparency=true",
  "affirm": "https://boards-api.greenhouse.io/v1/boards/affirm/jobs?content=true&pay_transparency=true",
  "automattic": "https://boards-api.greenhouse.io/v1/boards/automatticcareers/jobs?content=true&pay_transparency=true",
  "brave": "https://boards-api.greenhouse.io/v1/boards/brave/jobs?content=true&pay_transparency=true",
  "brex": "https://boards-api.greenhouse.io/v1/boards/brex/jobs?content=true&pay_transparency=true",
  "canonical": "https://boards-api.greenhouse.io/v1/boards/canonical/jobs?content=true&pay_transparency=true",
  "clickhouse": "https://api.ashbyhq.com/posting-api/job-board/ClickHouse?includeCompensation=true",
  "cockroachlabs": "https://boards-api.greenhouse.io/v1/boards/cockroachlabs/jobs?content=true&pay_transparency=true",
  "cohere": "https://api.ashbyhq.com/posting-api/job-board/cohere?includeCompensation=true",
  "confluent": "https://api.ashbyhq.com/posting-api/job-board/confluent?includeCompensation=true",
  "coupang": "https://boards-api.greenhouse.io/v1/boards/coupang/jobs?content=true&pay_transparency=true",
  "cursor": "https://api.ashbyhq.com/posting-api/job-board/cursor?includeCompensation=true",
  "delivery-hero": "https://api.smartrecruiters.com/v1/companies/DeliveryHero/postings?limit=100&offset=0&destination=PUBLIC",
  "digitalocean": "https://boards-api.greenhouse.io/v1/boards/digitalocean98/jobs?content=true&pay_transparency=true",
  "docker": "https://api.ashbyhq.com/posting-api/job-board/docker?includeCompensation=true",
  "elastic": "https://boards-api.greenhouse.io/v1/boards/elastic/jobs?content=true&pay_transparency=true",
  "elevenlabs": "https://api.ashbyhq.com/posting-api/job-board/elevenlabs?includeCompensation=true",
  "epicgames": "https://boards-api.greenhouse.io/v1/boards/epicgames/jobs?content=true&pay_transparency=true",
  "fivetran": "https://boards-api.greenhouse.io/v1/boards/fivetran/jobs?content=true&pay_transparency=true",
  "grafana": "https://boards-api.greenhouse.io/v1/boards/grafanalabs/jobs?content=true&pay_transparency=true",
  "kong": "https://api.ashbyhq.com/posting-api/job-board/kong?includeCompensation=true",
  "lyft": "https://boards-api.greenhouse.io/v1/boards/lyft/jobs?content=true&pay_transparency=true",
  "miro": "https://boards-api.greenhouse.io/v1/boards/realtimeboardglobal/jobs?content=true&pay_transparency=true",
  "mozilla": "https://boards-api.greenhouse.io/v1/boards/mozilla/jobs?content=true&pay_transparency=true",
  "n26": "https://boards-api.greenhouse.io/v1/boards/n26/jobs?content=true&pay_transparency=true",
  "okta": "https://boards-api.greenhouse.io/v1/boards/okta/jobs?content=true&pay_transparency=true",
  "palantir": "https://api.lever.co/v0/postings/palantir?mode=json&limit=50&skip=0",
  "perplexity": "https://api.ashbyhq.com/posting-api/job-board/perplexity?includeCompensation=true",
  "plaid": "https://api.ashbyhq.com/posting-api/job-board/plaid?includeCompensation=true",
  "posthog": "https://api.ashbyhq.com/posting-api/job-board/posthog?includeCompensation=true",
  "proton": "https://boards-api.greenhouse.io/v1/boards/proton/jobs?content=true&pay_transparency=true",
  "ramp": "https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true",
  "replit": "https://api.ashbyhq.com/posting-api/job-board/replit?includeCompensation=true",
  "riotgames": "https://boards-api.greenhouse.io/v1/boards/riotgames/jobs?content=true&pay_transparency=true",
  "runway": "https://api.ashbyhq.com/posting-api/job-board/runway-ml?includeCompensation=true",
  "scaleai": "https://boards-api.greenhouse.io/v1/boards/scaleai/jobs?content=true&pay_transparency=true",
  "sentry": "https://api.ashbyhq.com/posting-api/job-board/sentry?includeCompensation=true",
  "servicenow": "https://api.smartrecruiters.com/v1/companies/ServiceNow/postings?limit=100&offset=0&destination=PUBLIC",
  "snowflake": "https://api.ashbyhq.com/posting-api/job-board/snowflake?includeCompensation=true",
  "temporal": "https://api.ashbyhq.com/posting-api/job-board/temporal?includeCompensation=true",
  "togetherai": "https://boards-api.greenhouse.io/v1/boards/togetherai/jobs?content=true&pay_transparency=true",
  "twilio": "https://boards-api.greenhouse.io/v1/boards/twilio/jobs?content=true&pay_transparency=true",
  "twitch": "https://boards-api.greenhouse.io/v1/boards/twitch/jobs?content=true&pay_transparency=true",
  "waymo": "https://boards-api.greenhouse.io/v1/boards/waymo/jobs?content=true&pay_transparency=true",
  "wikimedia": "https://boards-api.greenhouse.io/v1/boards/wikimedia/jobs?content=true&pay_transparency=true",
  "xai": "https://boards-api.greenhouse.io/v1/boards/xai/jobs?content=true&pay_transparency=true",
  "zoox": "https://api.lever.co/v0/postings/zoox?mode=json&limit=50&skip=0",
}

export const SURVEY_PRESENCE_URLS: Record<string, string> = {
  "adyen": "https://boards-api.greenhouse.io/v1/boards/adyen/jobs?content=false",
  "affirm": "https://boards-api.greenhouse.io/v1/boards/affirm/jobs?content=false",
  "automattic": "https://boards-api.greenhouse.io/v1/boards/automatticcareers/jobs?content=false",
  "brave": "https://boards-api.greenhouse.io/v1/boards/brave/jobs?content=false",
  "brex": "https://boards-api.greenhouse.io/v1/boards/brex/jobs?content=false",
  "canonical": "https://boards-api.greenhouse.io/v1/boards/canonical/jobs?content=false",
  "clickhouse": "https://api.ashbyhq.com/posting-api/job-board/ClickHouse",
  "cockroachlabs": "https://boards-api.greenhouse.io/v1/boards/cockroachlabs/jobs?content=false",
  "cohere": "https://api.ashbyhq.com/posting-api/job-board/cohere",
  "confluent": "https://api.ashbyhq.com/posting-api/job-board/confluent",
  "coupang": "https://boards-api.greenhouse.io/v1/boards/coupang/jobs?content=false",
  "cursor": "https://api.ashbyhq.com/posting-api/job-board/cursor",
  "delivery-hero": "https://api.smartrecruiters.com/v1/companies/DeliveryHero/postings?limit=100&offset=0&destination=PUBLIC",
  "digitalocean": "https://boards-api.greenhouse.io/v1/boards/digitalocean98/jobs?content=false",
  "docker": "https://api.ashbyhq.com/posting-api/job-board/docker",
  "elastic": "https://boards-api.greenhouse.io/v1/boards/elastic/jobs?content=false",
  "elevenlabs": "https://api.ashbyhq.com/posting-api/job-board/elevenlabs",
  "epicgames": "https://boards-api.greenhouse.io/v1/boards/epicgames/jobs?content=false",
  "fivetran": "https://boards-api.greenhouse.io/v1/boards/fivetran/jobs?content=false",
  "grafana": "https://boards-api.greenhouse.io/v1/boards/grafanalabs/jobs?content=false",
  "kong": "https://api.ashbyhq.com/posting-api/job-board/kong",
  "lyft": "https://boards-api.greenhouse.io/v1/boards/lyft/jobs?content=false",
  "miro": "https://boards-api.greenhouse.io/v1/boards/realtimeboardglobal/jobs?content=false",
  "mozilla": "https://boards-api.greenhouse.io/v1/boards/mozilla/jobs?content=false",
  "n26": "https://boards-api.greenhouse.io/v1/boards/n26/jobs?content=false",
  "okta": "https://boards-api.greenhouse.io/v1/boards/okta/jobs?content=false",
  "palantir": "https://api.lever.co/v0/postings/palantir?mode=json&limit=50&skip=0",
  "perplexity": "https://api.ashbyhq.com/posting-api/job-board/perplexity",
  "plaid": "https://api.ashbyhq.com/posting-api/job-board/plaid",
  "posthog": "https://api.ashbyhq.com/posting-api/job-board/posthog",
  "proton": "https://boards-api.greenhouse.io/v1/boards/proton/jobs?content=false",
  "ramp": "https://api.ashbyhq.com/posting-api/job-board/ramp",
  "replit": "https://api.ashbyhq.com/posting-api/job-board/replit",
  "riotgames": "https://boards-api.greenhouse.io/v1/boards/riotgames/jobs?content=false",
  "runway": "https://api.ashbyhq.com/posting-api/job-board/runway-ml",
  "scaleai": "https://boards-api.greenhouse.io/v1/boards/scaleai/jobs?content=false",
  "sentry": "https://api.ashbyhq.com/posting-api/job-board/sentry",
  "servicenow": "https://api.smartrecruiters.com/v1/companies/ServiceNow/postings?limit=100&offset=0&destination=PUBLIC",
  "snowflake": "https://api.ashbyhq.com/posting-api/job-board/snowflake",
  "temporal": "https://api.ashbyhq.com/posting-api/job-board/temporal",
  "togetherai": "https://boards-api.greenhouse.io/v1/boards/togetherai/jobs?content=false",
  "twilio": "https://boards-api.greenhouse.io/v1/boards/twilio/jobs?content=false",
  "twitch": "https://boards-api.greenhouse.io/v1/boards/twitch/jobs?content=false",
  "waymo": "https://boards-api.greenhouse.io/v1/boards/waymo/jobs?content=false",
  "wikimedia": "https://boards-api.greenhouse.io/v1/boards/wikimedia/jobs?content=false",
  "xai": "https://boards-api.greenhouse.io/v1/boards/xai/jobs?content=false",
  "zoox": "https://api.lever.co/v0/postings/zoox?mode=json&limit=50&skip=0",
}

// Native IDs and expected public source IDs are separately stored literals.
export const SURVEY_JOBS = [
  {"companyId":"adyen","source":"greenhouse","nativeId":61001,"id":"greenhouse-adyen-61001","title":"Backend Engineer — Synthetic Amber Payments61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/adyen-61001"},
  {"companyId":"affirm","source":"greenhouse","nativeId":61002,"id":"greenhouse-affirm-61002","title":"Backend Engineer — Synthetic Bronze Credit61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/affirm-61002"},
  {"companyId":"automattic","source":"greenhouse","nativeId":61003,"id":"greenhouse-automattic-61003","title":"Backend Engineer — Synthetic Cedar Publishing61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/automattic-61003"},
  {"companyId":"brave","source":"greenhouse","nativeId":61004,"id":"greenhouse-brave-61004","title":"Backend Engineer — Synthetic Dawn Browser61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/brave-61004"},
  {"companyId":"brex","source":"greenhouse","nativeId":61005,"id":"greenhouse-brex-61005","title":"Backend Engineer — Synthetic Elm Ledger61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/brex-61005"},
  {"companyId":"canonical","source":"greenhouse","nativeId":61006,"id":"greenhouse-canonical-61006","title":"Backend Engineer — Synthetic Fir Linux61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/canonical-61006"},
  {"companyId":"clickhouse","source":"ashby","nativeId":"synthetic-61007","id":"ashby-clickhouse-synthetic-61007","title":"Backend Engineer — Synthetic Granite Tables61","role":"backend","cityIds":["london"],"location":"London, United Kingdom","country":"GB","url":"https://example.com/synthetic/stage61/clickhouse-61007"},
  {"companyId":"cockroachlabs","source":"greenhouse","nativeId":61008,"id":"greenhouse-cockroachlabs-61008","title":"Backend Engineer — Synthetic Hazel Database61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/cockroachlabs-61008"},
  {"companyId":"cohere","source":"ashby","nativeId":"synthetic-61009","id":"ashby-cohere-synthetic-61009","title":"Backend Engineer — Synthetic Iris Language61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/cohere-61009"},
  {"companyId":"confluent","source":"ashby","nativeId":"synthetic-61010","id":"ashby-confluent-synthetic-61010","title":"Backend Engineer — Synthetic Juniper Stream61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/confluent-61010"},
  {"companyId":"coupang","source":"greenhouse","nativeId":61011,"id":"greenhouse-coupang-61011","title":"Backend Engineer — Synthetic Kite Delivery61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/coupang-61011"},
  {"companyId":"cursor","source":"ashby","nativeId":"synthetic-61012","id":"ashby-cursor-synthetic-61012","title":"Frontend Engineer — Synthetic Linden Editor61","role":"frontend","cityIds":["london"],"location":"London, United Kingdom","country":"GB","url":"https://example.com/synthetic/stage61/cursor-61012"},
  {"companyId":"delivery-hero","source":"smartrecruiters","nativeId":"synthetic-61013","id":"smartrecruiters-delivery-hero-synthetic-61013","title":"Backend Engineer — Synthetic Maple Dispatch61","role":"backend","cityIds":["berlin"],"location":"Berlin, Germany","country":"DE","url":"https://example.com/synthetic/stage61/delivery-hero-61013"},
  {"companyId":"digitalocean","source":"greenhouse","nativeId":61014,"id":"greenhouse-digitalocean-61014","title":"Backend Engineer — Synthetic Nectar Droplets61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/digitalocean-61014"},
  {"companyId":"docker","source":"ashby","nativeId":"synthetic-61015","id":"ashby-docker-synthetic-61015","title":"Backend Engineer — Synthetic Oak Containers61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/docker-61015"},
  {"companyId":"elastic","source":"greenhouse","nativeId":61016,"id":"greenhouse-elastic-61016","title":"Backend Engineer — Synthetic Pine Search61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/elastic-61016"},
  {"companyId":"elevenlabs","source":"ashby","nativeId":"synthetic-61017","id":"ashby-elevenlabs-synthetic-61017","title":"Backend Engineer — Synthetic Quartz Voice61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/elevenlabs-61017"},
  {"companyId":"epicgames","source":"greenhouse","nativeId":61018,"id":"greenhouse-epicgames-61018","title":"Backend Engineer — Synthetic Reed Engine61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/epicgames-61018"},
  {"companyId":"fivetran","source":"greenhouse","nativeId":61019,"id":"greenhouse-fivetran-61019","title":"Backend Engineer — Synthetic Spruce Sync61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/fivetran-61019"},
  {"companyId":"grafana","source":"greenhouse","nativeId":61020,"id":"greenhouse-grafana-61020","title":"Backend Engineer — Synthetic Thistle Metrics61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/grafana-61020"},
  {"companyId":"kong","source":"ashby","nativeId":"synthetic-61021","id":"ashby-kong-synthetic-61021","title":"Backend Engineer — Synthetic Umber Gateway61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/kong-61021"},
  {"companyId":"lyft","source":"greenhouse","nativeId":61022,"id":"greenhouse-lyft-61022","title":"Backend Engineer — Synthetic Violet Rides61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/lyft-61022"},
  {"companyId":"miro","source":"greenhouse","nativeId":61023,"id":"greenhouse-miro-61023","title":"Frontend Engineer — Synthetic Willow Canvas61","role":"frontend","cityIds":["berlin"],"location":"Berlin, Germany","country":"DE","url":"https://example.com/synthetic/stage61/miro-61023"},
  {"companyId":"mozilla","source":"greenhouse","nativeId":61024,"id":"greenhouse-mozilla-61024","title":"Backend Engineer — Synthetic Xenon Browser61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/mozilla-61024"},
  {"companyId":"n26","source":"greenhouse","nativeId":61025,"id":"greenhouse-n26-61025","title":"Backend Engineer — Synthetic Yarrow Wallet61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/n26-61025"},
  {"companyId":"okta","source":"greenhouse","nativeId":61026,"id":"greenhouse-okta-61026","title":"Backend Engineer — Synthetic Zinnia Identity61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/okta-61026"},
  {"companyId":"palantir","source":"lever","nativeId":"synthetic-61027","id":"lever-palantir-synthetic-61027","title":"Backend Engineer — Synthetic Acorn Analysis61","role":"backend","cityIds":["london"],"location":"London, United Kingdom","country":"GB","url":"https://example.com/synthetic/stage61/palantir-61027"},
  {"companyId":"perplexity","source":"ashby","nativeId":"synthetic-61028","id":"ashby-perplexity-synthetic-61028","title":"Backend Engineer — Synthetic Birch Answers61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/perplexity-61028"},
  {"companyId":"plaid","source":"ashby","nativeId":"synthetic-61029","id":"ashby-plaid-synthetic-61029","title":"Backend Engineer — Synthetic Clover Finance61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/plaid-61029"},
  {"companyId":"posthog","source":"ashby","nativeId":"synthetic-61030","id":"ashby-posthog-synthetic-61030","title":"Backend Engineer — Synthetic Dahlia Events61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/posthog-61030"},
  {"companyId":"proton","source":"greenhouse","nativeId":61031,"id":"greenhouse-proton-61031","title":"Backend Engineer — Synthetic Evergreen Mail61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/proton-61031"},
  {"companyId":"ramp","source":"ashby","nativeId":"synthetic-61032","id":"ashby-ramp-synthetic-61032","title":"Backend Engineer — Synthetic Fern Expenses61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/ramp-61032"},
  {"companyId":"replit","source":"ashby","nativeId":"synthetic-61033","id":"ashby-replit-synthetic-61033","title":"Backend Engineer — Synthetic Glacier Workspace61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/replit-61033"},
  {"companyId":"riotgames","source":"greenhouse","nativeId":61034,"id":"greenhouse-riotgames-61034","title":"Backend Engineer — Synthetic Heather Games61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/riotgames-61034"},
  {"companyId":"runway","source":"ashby","nativeId":"synthetic-61035","id":"ashby-runway-synthetic-61035","title":"Backend Engineer — Synthetic Indigo Frames61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/runway-61035"},
  {"companyId":"scaleai","source":"greenhouse","nativeId":61036,"id":"greenhouse-scaleai-61036","title":"Backend Engineer — Synthetic Jade Data61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/scaleai-61036"},
  {"companyId":"sentry","source":"ashby","nativeId":"synthetic-61037","id":"ashby-sentry-synthetic-61037","title":"Backend Engineer — Synthetic Kestrel Errors61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/sentry-61037"},
  {"companyId":"servicenow","source":"smartrecruiters","nativeId":"synthetic-61038","id":"smartrecruiters-servicenow-synthetic-61038","title":"Backend Engineer — Synthetic Laurel Workflow61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/servicenow-61038"},
  {"companyId":"snowflake","source":"ashby","nativeId":"synthetic-61039","id":"ashby-snowflake-synthetic-61039","title":"Backend Engineer — Synthetic Meadow Warehouse61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/snowflake-61039"},
  {"companyId":"temporal","source":"ashby","nativeId":"synthetic-61040","id":"ashby-temporal-synthetic-61040","title":"Backend Engineer — Synthetic Nimbus Tasks61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/temporal-61040"},
  {"companyId":"togetherai","source":"greenhouse","nativeId":61041,"id":"greenhouse-togetherai-61041","title":"Backend Engineer — Synthetic Opal Models61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/togetherai-61041"},
  {"companyId":"twilio","source":"greenhouse","nativeId":61042,"id":"greenhouse-twilio-61042","title":"Backend Engineer — Synthetic Pebble Messages61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/twilio-61042"},
  {"companyId":"twitch","source":"greenhouse","nativeId":61043,"id":"greenhouse-twitch-61043","title":"Backend Engineer — Synthetic River Video61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/twitch-61043"},
  {"companyId":"waymo","source":"greenhouse","nativeId":61044,"id":"greenhouse-waymo-61044","title":"Backend Engineer — Synthetic Saffron Drive61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/waymo-61044"},
  {"companyId":"wikimedia","source":"greenhouse","nativeId":61045,"id":"greenhouse-wikimedia-61045","title":"Backend Engineer — Synthetic Tulip Knowledge61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/wikimedia-61045"},
  {"companyId":"xai","source":"greenhouse","nativeId":61046,"id":"greenhouse-xai-61046","title":"Backend Engineer — Synthetic Umber Orbit61","role":"backend","cityIds":["seoul"],"location":"Seoul, South Korea","country":"KR","url":"https://example.com/synthetic/stage61/xai-61046"},
  {"companyId":"zoox","source":"lever","nativeId":"synthetic-61047","id":"lever-zoox-synthetic-61047","title":"Backend Engineer — Synthetic Verdant Fleet61","role":"backend","cityIds":["san-francisco"],"location":"San Francisco, California, United States","country":"US","url":"https://example.com/synthetic/stage61/zoox-61047"},
] as const

export const SURVEY_DETAIL_URLS = [
  'https://api.smartrecruiters.com/v1/companies/DeliveryHero/postings/synthetic-61013',
  'https://api.smartrecruiters.com/v1/companies/ServiceNow/postings/synthetic-61038',
] as const
export const SURVEY_NOW = '2026-09-26T10:00:00.000Z'
export const SURVEY_UPDATED_AT = '2026-09-25T08:00:00.000Z'
export const SURVEY_SERVICE_TITLE = 'Backend Engineer — Synthetic Laurel Workflow61'
export const SURVEY_SERVICE_CHANGED_TITLE = 'Backend Engineer — Synthetic Laurel Workflow61 Updated'
export const SURVEY_SERVICE_BODY = 'Responsibilities\nBuild a fictional workflow service with TypeScript in Seoul.\n\nQualifications\n3 years of software engineering experience with PostgreSQL.'
export const SURVEY_SERVICE_CHANGED_BODY = 'Responsibilities\nBuild a fictional revised workflow service with TypeScript in Seoul.\n\nQualifications\n3 years of software engineering experience with PostgreSQL.'
export const SURVEY_NOTE = '가상 Stage61 메모 — ServiceNow / café\n본문과 목록을 따로 확인 🌿'
export const SURVEY_OLD_NOTE = 'Stage61 이전 Notion 메모 — 원래 출처 보존'
export const SURVEY_OLD_SCOPE_KEY = '1b1b7db34412d4ddd0104e2a0cc1db9e396977ca3cf90e25ec4c7fc08778b269'
export const SURVEY_METHOD = 'observations-1.occupation-4.roles-1.qualifications-1.remote-2.employment-1.purpose-1'

/** Keep earlier tests' posting cases intact while exercising the83-board default. */
export function withSurveyEmptyBoards(original: Record<string, unknown> = publicCoverageResponses()) {
  const result = { ...original }
  for (const company of SURVEY_REGISTRATIONS) {
    result[SURVEY_FULL_URLS[company.id]] = company.provider === 'greenhouse' ? { jobs: [], meta: { total: 0 } }
      : company.provider === 'ashby' ? { apiVersion: '1', jobs: [] }
        : company.provider === 'lever' ? []
          : { offset: 0, limit: 100, totalFound: 0, content: [] }
  }
  return result
}

/** Raw feeds exercise all47 additions; the expected public job IDs stay literal. */
export function surveyResponses(options: {
  changedServiceNow?: boolean
  nextDay?: boolean
  failures?: boolean
} = {}): Record<string, unknown> {
  const full = expansionResponses()
  for (const job of SURVEY_JOBS) {
    const description = `Synthetic posting: develop ${job.role} software with TypeScript in ${job.location}.\n\nQualifications: 3 years of software engineering experience with PostgreSQL.`
    if (job.source === 'greenhouse') {
      const jobs = [coverageGreenhouseRaw(job.nativeId, job.title, job.companyId, {
        absolute_url: job.url, updated_at: SURVEY_UPDATED_AT,
        location: { name: job.location }, content: `<p>${description}</p>`,
        departments: [{ name: 'Software Engineering' }],
      })]
      if (job.companyId === 'xai') {
        jobs.push(
          coverageGreenhouseRaw(61901, 'Backend Engineer — Synthetic Future Orbit61', 'xai', {
            internal_job_id: null, updated_at: SURVEY_UPDATED_AT,
            absolute_url: 'https://example.com/synthetic/stage61/xai-pool-61901',
            content: '<p>This synthetic registration collects profiles for future software engineering opportunities. No current opening is advertised.</p>',
          }),
          coverageGreenhouseRaw(61902, 'Account Executive — Synthetic Orbit Accounts61', 'xai', {
            updated_at: SURVEY_UPDATED_AT, departments: [{ name: 'Sales' }],
            absolute_url: 'https://example.com/synthetic/stage61/xai-sales-61902',
            content: '<p>Manage fictional customer subscriptions and renewals.</p>',
          }),
        )
      }
      if (job.companyId === 'adyen' && options.nextDay) jobs.push(
        coverageGreenhouseRaw(61905, 'Frontend Engineer — Synthetic Amber Payments61 Next', 'adyen', {
          updated_at: SURVEY_UPDATED_AT,
          absolute_url: 'https://example.com/synthetic/stage61/adyen-next-61905',
          content: '<p>Develop fictional frontend interfaces with TypeScript and React in Seoul.</p>',
        }),
      )
      full[SURVEY_FULL_URLS[job.companyId]] = { jobs, meta: { total: jobs.length } }
    } else if (job.source === 'ashby') {
      const jobs: {
        id: string; title: string; jobUrl: string; isListed: boolean
        department: string; location: string; workplaceType: string
        isRemote: boolean; employmentType: string; descriptionPlain: string
      }[] = [{
        id: job.nativeId, title: job.title, jobUrl: job.url, isListed: true,
        department: 'Software Engineering', location: job.location,
        workplaceType: 'OnSite', isRemote: false, employmentType: 'FullTime',
        descriptionPlain: description,
      }]
      if (job.companyId === 'cursor') jobs.push({
        ...jobs[0], id: 'synthetic-61903', isListed: false,
        title: 'Frontend Engineer — Synthetic Unlisted Editor61',
        jobUrl: 'https://example.com/synthetic/stage61/cursor-unlisted-61903',
      })
      full[SURVEY_FULL_URLS[job.companyId]] = { apiVersion: '1', jobs }
    } else if (job.source === 'lever') {
      full[SURVEY_FULL_URLS[job.companyId]] = [{
        id: job.nativeId, text: job.title, hostedUrl: job.url,
        categories: { location: job.location, department: 'Software Engineering', commitment: 'Full-time' },
        country: job.country, workplaceType: 'on-site', descriptionPlain: description,
      }]
    } else {
      const changed = job.companyId === 'servicenow' && options.changedServiceNow
      const company = job.companyId === 'servicenow' ? 'ServiceNow' : 'DeliveryHero'
      const detail = {
        id: job.nativeId, name: changed ? SURVEY_SERVICE_CHANGED_TITLE : job.title,
        company: { identifier: company }, visibility: 'PUBLIC', active: true,
        releasedDate: SURVEY_UPDATED_AT, postingUrl: job.url,
        location: {
          city: job.companyId === 'servicenow' ? 'Seoul' : 'Berlin',
          country: job.country.toLowerCase(), fullLocation: job.location, remote: false, hybrid: false,
        },
        typeOfEmployment: { label: 'Full-time' }, function: { label: 'Software Engineering' },
        jobAd: { sections: {
          jobDescription: { title: 'Responsibilities', text: job.companyId === 'servicenow'
            ? `<p>Build a fictional ${changed ? 'revised ' : ''}workflow service with TypeScript in Seoul.</p>`
            : '<p>Build a fictional delivery service with TypeScript in Berlin.</p>' },
          qualifications: { title: 'Qualifications', text: '<p>3 years of software engineering experience with PostgreSQL.</p>' },
        } },
      }
      const content: unknown[] = [{
        id: detail.id, name: detail.name, company: detail.company, visibility: detail.visibility,
        releasedDate: detail.releasedDate, location: detail.location, function: detail.function,
        typeOfEmployment: detail.typeOfEmployment,
      }]
      if (job.companyId === 'servicenow') content.push({
        id: 'synthetic-61904', name: 'Account Executive — Synthetic Workflow Accounts61',
        company: { identifier: 'ServiceNow' }, visibility: 'PUBLIC', releasedDate: SURVEY_UPDATED_AT,
        function: { label: 'Sales' },
      })
      full[SURVEY_FULL_URLS[job.companyId]] = { offset: 0, limit: 100, totalFound: content.length, content }
      full[job.companyId === 'servicenow' ? SURVEY_DETAIL_URLS[1] : SURVEY_DETAIL_URLS[0]] = detail
    }
  }
  const responses = coveragePresenceResponses(full)
  if (options.failures) {
    responses[SURVEY_FULL_URLS.xai] = coverageReply({ error: 'Fictional board unavailable' }, { status: 503 })
    responses[SURVEY_FULL_URLS.clickhouse] = { apiVersion: 'unsupported-fictional-version', jobs: [] }
    responses[SURVEY_FULL_URLS.palantir] = coverageReply({ error: 'Fictional rate limit' }, { status: 429, headers: { 'Retry-After': '120' } })
    responses[SURVEY_DETAIL_URLS[1]] = coverageReply({ error: 'Fictional body unavailable' }, { status: 503 })
  }
  return responses
}

export function surveyOldSaved(fetchedAt: string): SavedJob[] {
  const old = expansionLegacy36Cache(fetchedAt)
  const job = old.boards.find(board => board.companyId === 'notion')!.snapshot.jobs[0] as Job
  return [{
    job: { ...job }, company: {
      id: 'notion', name: 'Notion', initials: 'N', color: '#e6e8e6',
      industry: '생산성 · 협업', careerUrl: 'https://www.notion.com/careers', provider: 'ashby', board: 'notion',
    },
    savedAt: fetchedAt, status: 'applied', note: SURVEY_OLD_NOTE,
  }]
}

/** A prior complete36-company cohort is an input, never an83-company baseline. */
export function surveyOldHistory() {
  const companies = [...ORIGINAL_PUBLIC_REGISTRATIONS, ...ADDED_PUBLIC_REGISTRATIONS, ...EXPANDED_PUBLIC_REGISTRATIONS]
  const at = '2026-09-25T10:00:00.000Z'
  const scope = {
    key: SURVEY_OLD_SCOPE_KEY,
    boards: companies.map(company => ({
      companyId: company.id, name: company.name, provider: company.provider!, board: company.board!,
    })).sort((left, right) => left.companyId.localeCompare(right.companyId, 'en')),
  }
  const attempt = {
    observedAt: at, recordedAt: at, origin: 'collection',
    boards: companies.map(company => ({ companyId: company.id, status: 'complete', checkedAt: at, lastSuccessAt: at })),
  }
  return {
    version: 1,
    series: [{
      scope, method: SURVEY_METHOD,
      days: [{
        day: '2026-09-25', latest: attempt,
        complete: {
          ...attempt, comparable: true, stats: {
            published: 2, technical: 2, openings: 2, talentPools: 0,
            companies: companies.map(company => ({
              companyId: company.id, name: company.name, count: company.id === 'stripe' || company.id === 'notion' ? 1 : 0,
            })),
            regions: [
              { key: 'americas', count: 0 }, { key: 'europe', count: 0 }, { key: 'asia-pacific', count: 2 },
              { key: 'remote', count: 0 }, { key: 'other', count: 0 }, { key: 'unknown', count: 0 },
            ],
            roles: [
              { key: 'backend', count: 2 }, { key: 'frontend', count: 0 }, { key: 'fullstack', count: 0 },
              { key: 'ml', count: 0 }, { key: 'data', count: 0 }, { key: 'devops', count: 0 },
              { key: 'mobile', count: 0 }, { key: 'security', count: 0 }, { key: 'unknown', count: 0 },
            ],
            workModes: [
              { key: 'remote', count: 0 }, { key: 'hybrid', count: 0 }, { key: 'onsite', count: 2 }, { key: 'unknown', count: 0 },
            ],
            skills: [], skillCount: 0,
          },
        },
      }],
    }],
  }
}
