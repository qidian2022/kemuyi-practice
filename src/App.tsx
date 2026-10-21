import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import catalogVersion from './generated/catalog-version.json'
import { deduplicateCatalog, makeRefs, type QuestionRef } from './catalog'
import {
  STORAGE_KEY, clearLegacyState, findUnansweredIndex, loadMigratedState, movePractice,
  recordAnswer, restartState, resumePractice, saveState,
  type OptionKey, type Page, type PracticeData, type Question, type SelectedQuestion,
} from './practice'

type Catalog = { version: string; questions: Question[]; selected: SelectedQuestion[] }
type Ownership = 'checking' | 'writer' | 'reader' | 'unsupported'
type PendingAdvance = { page: Page; id: number; index: number }
const lockName = 'kemuyi-practice-writer-v3'
const channelName = 'kemuyi-practice-takeover-v3'

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    bookmark: <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4V4.5Z" />,
    arrowRight: <><path d="M4 12h16" /><path d="m13 5 7 7-7 7" /></>,
    arrowLeft: <><path d="M20 12H4" /><path d="m11 5-7 7 7 7" /></>,
    external: <><path d="M14 4h6v6" /><path d="M10 14 20 4" /><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" /></>,
    restart: <><path d="M3 11a9 9 0 1 1 2.3 7" /><path d="M3 4v7h7" /></>,
    check: <path d="m5 12 4.5 4.5L19 7" />,
    close: <><path d="M6 6 18 18" /><path d="M18 6 6 18" /></>,
    star: <path d="m12 2.5 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9L12 2.5Z" />,
    spark: <><path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z" /><path d="m19 17 .6 1.4L21 19l-1.4.6L19 21l-.6-1.4L17 19l1.4-.6L19 17Z" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function QuestionImage({ path }: { path: string }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const imageRef = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const image = imageRef.current
    if (image?.complete) setStatus(image.naturalWidth > 0 ? 'loaded' : 'error')
  }, [path])
  return <div className="question-image">
    {status !== 'loaded' && <p className="question-image-message" role="status">
      {status === 'error' ? '图片加载失败，请尝试刷新/打开VPN' : '图片正在加载，长时间等待请尝试刷新/打开VPN'}
    </p>}
    <img ref={imageRef} src={`${import.meta.env.BASE_URL}${path}`} alt="题目配图" loading="eager"
      decoding="async" className={status === 'loaded' ? 'loaded' : ''}
      onLoad={() => setStatus('loaded')} onError={() => setStatus('error')} />
  </div>
}

function Stats({ answered, total, correct, favorites }: { answered: number; total: number; correct: number; favorites: number }) {
  const accuracy = answered ? Math.round(correct / answered * 100) : 0
  return <section className="stats" aria-label="练习数据">
    <div className="stat">
      <span>已练题目</span><div><strong>{answered}</strong><small> / {total}</small></div>
      <div className="stat-track"><span style={{ width: `${total ? answered / total * 100 : 0}%` }} /></div>
    </div>
    <div className="stat">
      <span>当前正确率</span><div><strong>{accuracy}</strong><small>%</small></div>
      <div className="stat-caption">答对 {correct} 题</div>
    </div>
    <div className="stat">
      <span>收藏题目</span><div><strong>{favorites}</strong><small> 道</small></div>
      <div className="stat-caption">两个题库的收藏与错题</div>
    </div>
  </section>
}

function ResetDialog({ compact, onClose, onConfirm }: { compact: boolean; onClose: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="reset-title">
      <div className="modal-symbol"><Icon name="restart" size={23} /></div>
      <h2 id="reset-title">重新开始练习？</h2>
      <p>{compact
        ? '这 300 道题在两个入口的答题记录都会清空，精选题序重新打乱；收藏保留。'
        : '全部答题记录和两个入口的进度会清空，题目重新打乱；收藏保留。'}</p>
      <div className="modal-actions">
        <button className="button-secondary" onClick={onClose}>继续练习</button>
        <button className="button-primary" onClick={onConfirm}>确认重新开始</button>
      </div>
    </div>
  </div>
}

type QuestionCardProps = {
  refItem: QuestionRef; index: number; total: number; selected?: OptionKey
  favorite: boolean; writable: boolean; pendingAdvance: boolean; canMoveBack: boolean; canMoveNext: boolean
  onFavorite: () => void; onAnswer: (answer: OptionKey) => void; onMove: (direction: 1 | -1) => void
}
function QuestionCard({ refItem, index, total, selected, favorite, writable, pendingAdvance, canMoveBack, canMoveNext, onFavorite, onAnswer, onMove }: QuestionCardProps) {
  const question = refItem.question
  return <section className="question-card" aria-labelledby="question-title">
    <div className="question-top">
      <div className="question-count"><span className="count-accent">{String(index + 1).padStart(2, '0')}</span><span className="count-divider">/</span>{total} <span className="count-label">题</span></div>
      <div className="question-tools">
        <span className="type-badge">{question.options.length === 2 ? '判断题' : '单选题'}</span>
        <button className={`favorite-button ${favorite ? 'is-favorite' : ''}`} onClick={onFavorite}
          disabled={!writable} aria-pressed={favorite} aria-label={favorite ? '取消收藏' : '收藏此题'}
          title={favorite ? '取消收藏' : '收藏此题'}><Icon name="bookmark" size={20} /></button>
      </div>
    </div>
    <div className="question-progress" aria-hidden="true"><span style={{ width: `${(index + 1) / total * 100}%` }} /></div>
    <div className="question-body">
      <div className="question-meta"><span>{question.chapter}</span><span className="meta-separator">·</span><span>{refItem.bank === 'compact' ? '精简题' : '原题'} #{question.id}</span></div>
      <h2 id="question-title">{question.question}</h2>
      {question.images.length > 0 && <div className="question-images">{question.images.map((path) => <QuestionImage key={path} path={path} />)}</div>}
      <div className="answer-hint">请选择一个答案</div>
      <div className="options">{question.options.map((option) => {
        const isCorrect = Boolean(selected) && option.key === question.answer
        const isWrong = selected === option.key && option.key !== question.answer
        return <button key={option.key} className={`option ${isCorrect ? 'correct' : ''} ${isWrong ? 'wrong' : ''}`}
          disabled={!writable || Boolean(selected)} onClick={() => onAnswer(option.key)}>
          <span className="option-letter">{option.key}</span><span className="option-text">{option.text}</span>
          {isCorrect && <span className="option-result"><Icon name="check" size={17} /></span>}
          {isWrong && <span className="option-result"><Icon name="close" size={17} /></span>}
        </button>
      })}</div>
      {selected && <div className={`explanation ${selected === question.answer ? 'is-correct' : 'is-wrong'}`} role="status">
        <div className="explanation-icon"><Icon name={selected === question.answer ? 'check' : 'close'} size={19} /></div>
        <div className="explanation-content">
          <strong>{selected === question.answer ? '答对了，很棒！' : `答错了，正确答案是 ${question.answer}`}</strong>
          <p>解析：{question.explanation || '原网站暂未提供解析。'}</p>
          <a href={question.sourceUrl} target="_blank" rel="noopener noreferrer">查看原题 <Icon name="external" size={14} /></a>
          {selected === question.answer && pendingAdvance && <span className="auto-result-note">即将继续练习</span>}
          {selected !== question.answer && favorite && <span className="auto-result-note">已在我的收藏中</span>}
        </div>
      </div>}
    </div>
    <div className="question-footer">
      <span className="keyboard-tip">按照自己的节奏，一题一题来</span>
      <div className="question-actions">
        <button className="button-secondary" disabled={!writable || !canMoveBack} onClick={() => onMove(-1)}><Icon name="arrowLeft" size={17} /> 上一题</button>
        <button className="button-primary" disabled={!writable || !canMoveNext} onClick={() => onMove(1)}>下一题 <Icon name="arrowRight" size={17} /></button>
      </div>
    </div>
  </section>
}

function PracticeApp({ catalog }: { catalog: Catalog }) {
  const { questions, selected, aliases } = useMemo(() => deduplicateCatalog(catalog.questions, catalog.selected), [catalog])
  const refs = useMemo(() => makeRefs(questions, selected), [questions, selected])
  const fullById = useMemo(() => new Map(refs.full.map((ref) => [ref.id, ref])), [refs])
  const compactById = useMemo(() => new Map(refs.compact.map((ref) => [ref.id, ref])), [refs])
  const selectedIds = useMemo(() => new Set(selected.map(({ id }) => id)), [selected])
  const [data, setData] = useState(() => loadMigratedState(questions, selected, aliases).state)
  const dataRef = useRef(data)
  const [ownership, setOwnership] = useState<Ownership>('checking')
  const ownershipRef = useRef(false)
  const [unsaved, setUnsaved] = useState(false)
  const unsavedRef = useRef(false)
  const [waiting, setWaiting] = useState(false)
  const [takeoverError, setTakeoverError] = useState(false)
  const [showReset, setShowReset] = useState(false)
  const [pendingAdvance, setPendingAdvance] = useState<PendingAdvance | null>(null)
  const acquireRef = useRef<(wait: boolean, signal?: AbortSignal) => void>(() => {})
  const takeoverAbortRef = useRef<AbortController | null>(null)
  const channelRef = useRef<BroadcastChannel | null>(null)
  const releaseRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let active = true
    if (!navigator.locks || !window.BroadcastChannel) {
      setOwnership('unsupported')
      return
    }
    const channel = new BroadcastChannel(channelName)
    channelRef.current = channel
    channel.onmessage = (event) => {
      if (event.data?.type === 'save-failed' && takeoverAbortRef.current && !takeoverAbortRef.current.signal.aborted) {
        takeoverAbortRef.current?.abort()
        takeoverAbortRef.current = null
        setWaiting(false)
        setTakeoverError(true)
        return
      }
      if (event.data?.type !== 'takeover' || !ownershipRef.current) return
      if (unsavedRef.current) {
        if (!saveState(dataRef.current, ownershipRef.current)) {
          channel.postMessage({ type: 'save-failed' })
          return
        }
        clearLegacyState()
      }
      unsavedRef.current = false
      setUnsaved(false)
      ownershipRef.current = false
      setOwnership('reader')
      setPendingAdvance(null)
      setShowReset(false)
      releaseRef.current?.()
    }
    const acquire = (wait: boolean, signal?: AbortSignal) => {
      void navigator.locks.request(lockName, wait ? { mode: 'exclusive', signal } : { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!active || !lock) {
          if (active) setOwnership('reader')
          return
        }
        const latest = loadMigratedState(questions, selected, aliases)
        dataRef.current = latest.state
        setData(latest.state)
        setPendingAdvance(null)
        ownershipRef.current = true
        const saved = !latest.needsSave || saveState(latest.state, ownershipRef.current)
        if (saved) clearLegacyState()
        unsavedRef.current = !saved
        setUnsaved(!saved)
        setWaiting(false)
        setTakeoverError(false)
        takeoverAbortRef.current = null
        setOwnership('writer')
        await new Promise<void>((resolve) => { releaseRef.current = resolve })
        releaseRef.current = null
        ownershipRef.current = false
        if (active) setOwnership('reader')
      }).catch(() => { if (active) { setOwnership('reader'); setWaiting(false); takeoverAbortRef.current = null } })
    }
    acquireRef.current = acquire
    queueMicrotask(() => { if (active) acquire(false) })
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || ownershipRef.current) return
      const latest = loadMigratedState(questions, selected, aliases)
      dataRef.current = latest.state
      setData(latest.state)
    }
    window.addEventListener('storage', onStorage)
    return () => {
      active = false
      ownershipRef.current = false
      takeoverAbortRef.current?.abort()
      releaseRef.current?.()
      window.removeEventListener('storage', onStorage)
      channel.close()
      channelRef.current = null
    }
  }, [questions, selected, aliases])

  function mutate(update: (previous: PracticeData) => PracticeData): boolean {
    if (!ownershipRef.current) return false
    const next = update(dataRef.current)
    if (next === dataRef.current) return false
    const saved = saveState(next, ownershipRef.current)
    dataRef.current = next
    setData(next)
    unsavedRef.current = !saved
    setUnsaved(!saved)
    if (saved) clearLegacyState()
    return true
  }

  function takeOver() {
    if (ownership !== 'reader' || waiting) return
    setWaiting(true)
    setTakeoverError(false)
    const controller = new AbortController()
    takeoverAbortRef.current = controller
    channelRef.current?.postMessage({ type: 'takeover' })
    acquireRef.current(true, controller.signal)
  }

  const favoriteSet = useMemo(() => new Set(data.favorites), [data.favorites])
  const page = data.page
  const visibleRefs = useMemo(() => {
    if (page === 'full') return data.full.order.map((id) => fullById.get(id)!).filter(Boolean)
    if (page === 'compact') return data.compact.order.map((id) => compactById.get(id)!).filter(Boolean)
    return data.full.order.map((id) => fullById.get(id)!).filter((ref) => ref && favoriteSet.has(ref.id))
  }, [page, data.full.order, data.compact.order, fullById, compactById, favoriteSet])
  const rawIndex = page === 'full' ? data.full.index : page === 'compact' ? data.compact.index : data.favoriteIndex
  const currentIndex = page === 'favorites' ? Math.min(rawIndex, Math.max(visibleRefs.length - 1, 0)) : rawIndex
  const currentRef = visibleRefs[currentIndex]
  const question = currentRef?.question
  const answer = currentRef && data.answers[currentRef.id]
  const practiceOrder = page === 'favorites' ? [] : data[page].order
  const previousIndex = findUnansweredIndex(practiceOrder, data.answers, currentIndex - 1, -1, false)
  const nextIndex = findUnansweredIndex(practiceOrder, data.answers, currentIndex + 1)
  const canMoveBack = page === 'favorites' ? currentIndex > 0 : previousIndex < practiceOrder.length
  const canMoveNext = page === 'favorites' ? currentIndex < visibleRefs.length - 1
    : Boolean(answer) || (nextIndex < practiceOrder.length && nextIndex !== currentIndex)
  const statRefs = page === 'full' ? refs.full : page === 'compact' ? refs.compact : visibleRefs
  const answeredCount = statRefs.filter((ref) => Boolean(data.answers[ref.id])).length
  const correctCount = statRefs.filter((ref) => data.answers[ref.id] === ref.question.answer).length
  const questionNumber = page === 'favorites' ? currentIndex + 1 : answeredCount + (answer ? 0 : 1)

  useEffect(() => {
    if (!pendingAdvance || ownership !== 'writer') return
    if (pendingAdvance.page !== page || pendingAdvance.id !== currentRef?.id ||
      pendingAdvance.index !== currentIndex || answer !== question?.answer) {
      setPendingAdvance(null)
      return
    }
    const timer = window.setTimeout(() => {
      mutate((previous) => {
        if (previous.page !== pendingAdvance.page) return previous
        if (previous.page === 'favorites') {
          return previous.favoriteIndex === pendingAdvance.index && visibleRefs[previous.favoriteIndex]?.id === pendingAdvance.id
            ? movePractice(previous, 1) : previous
        }
        const bank = previous[previous.page]
        return bank.index === pendingAdvance.index && bank.order[bank.index] === pendingAdvance.id
          ? movePractice(previous, 1) : previous
      })
      setPendingAdvance(null)
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [pendingAdvance, ownership, page, currentRef?.id, currentIndex, answer, question?.answer, visibleRefs])

  function switchPage(nextPage: Page) {
    setPendingAdvance(null)
    mutate((previous) => resumePractice(previous, nextPage))
  }
  function toggleFavorite() {
    if (!currentRef) return
    const id = currentRef.id
    mutate((previous) => ({ ...previous, favorites: previous.favorites.includes(id)
      ? previous.favorites.filter((favorite) => favorite !== id) : [...previous.favorites, id] }))
  }
  function answerQuestion(selectedAnswer: OptionKey) {
    if (!currentRef || !question || answer) return
    if (mutate((previous) => recordAnswer(previous, currentRef.id, selectedAnswer, question.answer)) &&
      selectedAnswer === question.answer && (page !== 'favorites' || canMoveNext)) {
      setPendingAdvance({ page, id: currentRef.id, index: currentIndex })
    }
  }
  function moveTo(direction: 1 | -1) {
    if (direction === -1 ? !canMoveBack : !canMoveNext) return
    setPendingAdvance(null)
    mutate((previous) => movePractice(previous, direction))
  }
  function restart() {
    setPendingAdvance(null)
    mutate((previous) => restartState(previous, page === 'compact' ? 'compact' : 'full', selectedIds))
    setShowReset(false)
  }

  const writable = ownership === 'writer'
  const pageName = page === 'full' ? '全量题库' : page === 'compact' ? 'C1/C2精简' : '我的收藏'
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">稳</div>
        <div><strong>稳稳过</strong><span>科目一练习 @qi_dian</span></div>
      </div>
      <nav className="nav-list" aria-label="练习栏目">
        <button className={`nav-item ${page === 'full' ? 'active' : ''}`} disabled={!writable}
          onClick={() => switchPage('full')} aria-current={page === 'full' ? 'page' : undefined}>
          <Icon name="grid" /><span>全量题库</span><small>{refs.full.length}</small>
        </button>
        <button className={`nav-item ${page === 'compact' ? 'active' : ''}`} disabled={!writable}
          onClick={() => switchPage('compact')} aria-current={page === 'compact' ? 'page' : undefined}>
          <Icon name="spark" /><span>C1/C2精简</span><small>{refs.compact.length}</small>
        </button>
        <button className={`nav-item ${page === 'favorites' ? 'active' : ''}`} disabled={!writable}
          onClick={() => switchPage('favorites')} aria-current={page === 'favorites' ? 'page' : undefined}>
          <Icon name="bookmark" /><span>我的收藏</span><small>{favoriteSet.size}</small>
        </button>
      </nav>
      <div className="sidebar-bottom">
        <div className="side-card">
          <div className="side-card-icon"><Icon name="spark" size={18} /></div>
          <strong>每天进步一点点</strong>
          <p>答错的题会自动加入收藏，方便之后集中复习。</p>
        </div>
        <div className="side-foot">数据仅保存在当前浏览器</div>
      </div>
    </aside>
    <main className="main-content">
      <header className="topbar">
        <div className="breadcrumb">{pageName}</div>
        <div className="topbar-right">
          <span className="topbar-status"><span className="status-dot" />离线题库 · 即开即练</span>
          <a className="star-link" href="https://github.com/qidian2022/kemuyi-practice"
            target="_blank" rel="noopener noreferrer" title="前往 GitHub 给项目 Star">
            <Icon name="star" size={16} />给项目 Star
          </a>
        </div>
      </header>
      <div className="content-wrap">
        {ownership !== 'writer' && <div className="storage-notice" role="status">
          <span>{ownership === 'checking' ? '正在检查练习记录…'
            : ownership === 'unsupported' ? '当前浏览器不支持安全的多标签页写入，请使用新版浏览器。'
              : takeoverError ? '另一标签页的当前进度尚未保存，暂不能接管。'
                : waiting ? '正在接管练习，请稍候…' : '另一标签页正在练习；此页为只读。'}</span>
          {ownership === 'reader' && <button className="button-secondary" disabled={waiting} onClick={takeOver}>接管练习</button>}
        </div>}
        {unsaved && <div className="storage-notice storage-error" role="alert">当前进度尚未保存，请保留此标签页并检查浏览器存储空间。</div>}
        <section className="welcome">
          <div className="eyebrow"><span className="eyebrow-line" /> 科目一 · {pageName}</div>
          <h1>{page === 'favorites' ? '把值得回看的题，留在这里。'
            : page === 'full' ? '把每一道题，做得更明白。'
              : `${refs.compact.length} 道核心题，集中练起来。`}</h1>
          <p>{page === 'favorites' ? '两个题库的手动收藏和答错题都在这里。'
            : page === 'full' ? '自动跳过已刷题，答对后 1 秒继续；精选与全量共用进度。'
              : '从全量原题中精选 300 道，共用答题记录，自动跳过已刷题。'}</p>
        </section>
        <Stats answered={answeredCount} total={statRefs.length} correct={correctCount} favorites={favoriteSet.size} />
        {currentRef ? <QuestionCard refItem={currentRef} index={questionNumber - 1} total={visibleRefs.length}
          selected={answer} favorite={favoriteSet.has(currentRef.id)} writable={writable}
          pendingAdvance={pendingAdvance?.id === currentRef.id} canMoveBack={canMoveBack} canMoveNext={canMoveNext}
          onFavorite={toggleFavorite}
          onAnswer={answerQuestion} onMove={moveTo} />
          : page !== 'favorites' ? <section className="empty-card" role="status">
            <div className="empty-icon"><Icon name="check" size={27} /></div>
            <h2>{page === 'compact' ? '精选题已全部刷完' : '全量题库已全部刷完'}</h2>
            <p>已刷完 {statRefs.length} 道题，答题记录已保留。可以到我的收藏回看错题。</p>
            <button className="button-primary" disabled={!writable}
              onClick={() => switchPage(page === 'compact' ? 'full' : 'favorites')}>
              {page === 'compact' ? '继续刷全题库' : '回看我的收藏'} <Icon name="arrowRight" size={17} />
            </button>
          </section> : <section className="empty-card">
            <div className="empty-icon"><Icon name="bookmark" size={27} /></div>
            <h2>还没有收藏的题目</h2>
            <p>答错的题会自动加入这里，也可以点击书签收藏。</p>
            <button className="button-primary" disabled={!writable} onClick={() => switchPage('full')}>
              去刷题 <Icon name="arrowRight" size={17} />
            </button>
          </section>}
        <div className="bottom-row">
          <div className="source-note">
            题库来源：<a href="https://www.aijiaxiao.com/tiba/kmy/" target="_blank" rel="noopener noreferrer">爱驾校</a>
            {' '}· 采集于 2026-09-23 · 内容未经官方核验
          </div>
          <button className="reset-link" disabled={!writable} onClick={() => { setPendingAdvance(null); setShowReset(true) }}>
            <Icon name="restart" size={16} /> 重新开始
          </button>
        </div>
      </div>
    </main>
    {showReset && <ResetDialog compact={page === 'compact'} onClose={() => setShowReset(false)} onConfirm={restart} />}
  </div>
}

function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`${import.meta.env.BASE_URL}data/catalog.json?v=${catalogVersion.version}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error('题库加载失败'); return response.json() })
      .then((value: Catalog) => {
        if (!Array.isArray(value.questions) || !Array.isArray(value.selected)) throw new Error('题库格式无效')
        setCatalog(value)
      })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [])
  if (error) return <div className="load-message" role="alert">题库加载失败，请刷新页面重试。</div>
  if (!catalog) return <div className="load-message" role="status">正在加载题库…</div>
  return <PracticeApp catalog={catalog} />
}

export default App
