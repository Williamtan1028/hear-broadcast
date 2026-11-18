import { isMobile } from '../../app/ui.tsx';

const ENTRIES = {
  rx: { href: '#/rx', title: '我是乘客', desc: '打開麥克風接收車站廣播，即時顯示多語字幕。' },
  station: { href: '#/station', title: '站務端', desc: '選擇模板或輸入文字，透過現有喇叭送出高頻廣播。' },
  admin: { href: '#/admin', title: '模板管理', desc: '編輯廣播模板、6 種語言翻譯與站點設定。' },
};

export default function Home() {
  // 手機開啟時把「我是乘客」放在最前面
  const order = isMobile() ? (['rx', 'station', 'admin'] as const) : (['station', 'rx', 'admin'] as const);
  return (
    <>
      <h1>聽見廣播：讓聽不到的人也能「看見」廣播</h1>
      <div className="card stack">
        <p>
          車站現有的廣播喇叭在播放廣播時，同時送出<strong>人耳聽不到的高頻聲波（19.5 kHz 以上）</strong>
          ，乘客手機的網頁接收並解碼，即時顯示中文、English、日本語、한국어、台語、客語字幕。不必加裝任何硬體。
        </p>
        <ul>
          <li>
            <strong>聲音天生帶有位置資訊</strong>：只有聽得到這支喇叭的人才收得到，自動判斷您在哪個月台。
          </li>
          <li>
            <strong>完全離線</strong>：模板庫存在手機裡，地下車站斷網時照樣能用。
          </li>
          <li>
            <strong>免安裝</strong>：直接用瀏覽器開啟，也可以加入主畫面。
          </li>
          <li>
            <strong>邊走邊收</strong>：自動補償走動造成的都卜勒頻率偏移。
          </li>
          <li>
            <strong>緊急疏散模式</strong>：緊急廣播會全螢幕紅色閃爍並震動。
          </li>
        </ul>
      </div>
      <div className="entries">
        {order.map((k) => (
          <a key={k} className="entry" href={ENTRIES[k].href}>
            <strong>{ENTRIES[k].title}</strong>
            <span className="muted">{ENTRIES[k].desc}</span>
          </a>
        ))}
      </div>
      <p style={{ marginTop: 16 }}>
        第一次在現場使用？先到 <a href="#/lab">硬體診斷</a> 用掃頻確認喇叭與手機可用的頻段。
      </p>
    </>
  );
}
