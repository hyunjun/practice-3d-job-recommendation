import { BoardConfigurationError, loadBoardConfiguration } from '../server/board-config'
import { PUBLIC_COMPANIES } from '../shared/companies'
import { JOB_SOURCE_LABELS } from '../shared/types'

const args = process.argv.slice(2)
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  console.log('사용법: npm run boards:check -- [설정 파일 경로]')
  console.log('경로를 생략하면 ORBIT_BOARDS_FILE 또는 .local/job-boards.json을 확인합니다.')
  console.log(`기본 회사 ID: ${PUBLIC_COMPANIES.map(company => company.id).join(', ')}`)
} else {
  try {
    if (args.length > 1 || args[0]?.startsWith('-')) {
      throw new BoardConfigurationError('설정 파일 경로 하나만 입력해 주세요. 사용법: npm run boards:check -- [설정 파일 경로]')
    }
    const config = await loadBoardConfiguration({ file: args[0] })
    console.log(config.filePath ? `설정 파일: ${JSON.stringify(config.filePath)}` : '기본 공개 게시판 목록을 사용합니다.')
    console.log(`적용 방법: ${config.mode === 'replace' ? '설정에 적은 회사만' : config.mode === 'extend' ? '기본 목록에 추가·등록 변경' : '기본 목록'}`)
    console.log(`설정 확인 완료: 공개 게시판 ${config.companies.length}개`)
    for (const company of config.companies) {
      console.log(`  ${company.id} · ${company.name} · ${JOB_SOURCE_LABELS[company.provider ?? 'greenhouse']} · ${company.board}${company.boardRegion ? ' (EU)' : ''}`)
    }
    console.log('네트워크 요청 없이 설정 형식을 확인했습니다. 실제 게시판 연결은 앱의 공개 공고 조회에서 확인해 주세요.')
  } catch (error) {
    console.error('공개 게시판 설정 오류:', error instanceof Error ? error.message : '설정을 읽지 못했습니다.')
    process.exitCode = 1
  }
}
