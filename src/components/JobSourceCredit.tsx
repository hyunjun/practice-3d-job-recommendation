import { safeExternalUrl } from '../../shared/matching'
import { isStarbucksTechnologyJob } from '../../shared/career-sources'
import type { Catalog, Job } from '../../shared/types'

export function JobSourceCredit({ job, detail = false }: {
  job: Pick<Job, 'source' | 'url'>
  detail?: boolean
}) {
  if (isStarbucksTechnologyJob(job)) return <div className="job-source-credit">
    <p>수집 범위: <a href="https://careers.starbucks.com/discover-opportunities/technology/" target="_blank" rel="noopener noreferrer">Starbucks Technology</a></p>
    {detail && <p>공식 채용 사이트의 Technology 분류를 수집합니다. 목록에서 빠졌더라도 분류 이동일 수 있으므로 채용 마감을 단정하지 않아요. 정상 조회 후 24시간 동안 자료를 재사용합니다.</p>}
  </div>
  if (job.source !== 'himalayas') return null
  const url = safeExternalUrl(job.url)
  return <div className="job-source-credit">
    <p>공고 제공: <a href="https://himalayas.app" target="_blank" rel="noopener noreferrer">Himalayas</a>{url && <> · <a href={url} target="_blank" rel="noopener noreferrer">Himalayas 원문</a></>}</p>
    {detail && <p>Himalayas에 게시된 원격 채용 자료입니다. 회사의 전체 공식 공고와 범위가 다르며, 실제 모집 여부와 지원 조건은 원문에서 확인해 주세요. 출처의 하루 단위 갱신에 맞춰 정상 조회 후 24시간 동안 같은 자료를 사용합니다.</p>}
  </div>
}

export function CatalogSourceCredit({ catalog }: { catalog: Catalog }) {
  if (catalog.source !== 'public') return null
  const himalayas = catalog.companies.some(company => company.provider === 'himalayas')
  const starbucks = catalog.companies.some(company => company.provider === 'careers' && company.board === 'starbucks-technology')
  if (!himalayas && !starbucks) return null
  return <div className="catalog-source-credit">
    {himalayas && <p>원격 공고 출처: <a href="https://himalayas.app" target="_blank" rel="noopener noreferrer">Himalayas</a> · 회사 공식 게시판과 수집 범위가 다릅니다.</p>}
    {starbucks && <p>Starbucks는 공식 채용 사이트의 Technology 분류를 수집합니다.</p>}
  </div>
}
