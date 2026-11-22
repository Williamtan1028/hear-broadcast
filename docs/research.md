# 聲波資料傳輸技術調研：ggwave、quiet.js、Yamaha SoundUD

> 本文件整理三個代表性「以聲音傳資料」方案的設計，作為「聽見廣播」數據機的借鏡與比較基準。
> 各項數據皆附來源；標示「推算」者為依原始碼公式計算，非文件直接寫明。
> 我們自己的實測對照（同一通道模擬下 ggwave vs 本系統）見 [benchmarks.md](benchmarks.md)。

## 1. 總覽

| 項目 | ggwave | quiet.js（liquid-dsp） | Yamaha SoundUD | **聽見廣播（本專案）** |
|---|---|---|---|---|
| 調變 | 多頻 FSK：同時 6 個音，每音 4 bits | 依 profile：GMSK、FSK16/8、BPSK、OFDM 等 | 未公開 | 單音連續相位 FSK，16 資料音＋2 同步音 |
| 超音波／高頻段 | 15.0 kHz 起，96 個頻率 × 46.875 Hz（約 15.0～19.5 kHz） | `ultrasonic` 中心 19 kHz、`ultrasonic-whisper` 19.5 kHz | 未公開 | **19.5～20.35 kHz**（可退到 19、18.5、18 kHz） |
| 同步 | 起始／結束標記音（16 bits marker） | liquid-dsp framing（前導序列＋CRC） | 未公開 | 前導碼 A B A B ＋ min() 偵測分數＋1 ms 精細對齊 |
| 錯誤更正 | Reed-Solomon，ECC 位元組數 = len < 4 ? 2 : max(4, 2⌊len/5⌋) | 內層迴旋碼（v27/v29）＋外層 RS（部分 profile）＋CRC | 未公開 | RS(nsym = 6)＋**軟判決抹除**＋**重送合併** |
| 速度 | 8～16 bytes/s | 依 profile，數百 bps～數十 kbps（OFDM 有線） | 未公開（只傳 ID） | 8.3 bytes/s（標準）、6.25 bytes/s（穩定） |
| 都卜勒 | 無補償 | 無專門補償（窄頻 GMSK 有一定容忍度） | 未公開 | **±150 Hz 頻偏搜尋＋決策導向追蹤** |
| 是否需要網路 | 否 | 否 | 依服務：手機 App 以 ID 對應內容 | **否：模板庫存在手機** |
| 授權／狀態 | MIT，持續維護 | BSD-3，已多年未更新（確切日期未能查證） | 商業授權 | 本專案 |

## 2. ggwave

**來源**：[ggwave README](https://github.com/ggerganov/ggwave)、[ggwave.h](https://raw.githubusercontent.com/ggerganov/ggwave/master/include/ggwave/ggwave.h)、[ggwave.cpp](https://raw.githubusercontent.com/ggerganov/ggwave/master/src/ggwave.cpp)、npm 套件 `ggwave@0.4.0` README。

- **調變**：多頻 FSK（README："multi-frequency Frequency-Shift Keying"）。資料切成 4-bit，每個時刻用 6 個音同時送 3 個位元組，每音代表一個 nibble。
- **頻率配置**：6 個音分佈在 4.5 kHz 的範圍內，切成 96 個等距頻率，間距 dF = 46.875 Hz（= 48000 / 1024，即每個 FFT bin）。一般模式 F0 = 1875 Hz、超音波模式 F0 = 15000 Hz。
- **協定**（`Protocols::kDefault()`）：

  | 協定 | 起始 bin | 起始頻率（推算） | 每次發送幀數 |
  |---|---|---|---|
  | AUDIBLE_NORMAL／FAST／FASTEST | 40 | 1875 Hz | 9／6／3 |
  | ULTRASOUND_NORMAL／FAST／FASTEST | 320 | 15000 Hz | 9／6／3 |
  | DT_*（雙音）、MT_*（單音） | 24 | 1125 Hz | 9／6／3 |

  預設取樣率 48 kHz、每幀 1024 樣本（約 21.3 ms），所以 ULTRASOUND_FAST 每 6 幀（約 128 ms）送 3 bytes（推算）。
- **同步**：開頭與結尾各有特殊的標記音（`m_nBitsInMarker = 16`，變長模式 16 幀）。
- **錯誤更正**：Reed-Solomon；ECC 位元組數 `len < 4 ? 2 : max(4, 2*(len/5))`。變長模式的長度欄位另以 RS(1, 2) 保護。
- **速度**：8～16 bytes/s（README）。最大 payload：變長 140 bytes、定長 64 bytes。
- **優點**：多音並行所以速度快；實作精簡、跨平台（C++、WASM、Python、Arduino）。
- **缺點／我們可以超越的地方**：
  1. **超音波模式從 15 kHz 開始**，最高約 19.5 kHz，大部分年輕人聽得到 15～17 kHz，違反我們「不打擾聽得到的人」的最高原則。
  2. 6 個音同時發送時，總音量上限固定下，每個音的功率只有 1/6（−7.8 dB）；在 20 kHz 附近喇叭與麥克風本來就衰減的情況下更吃虧。
  3. 沒有都卜勒補償：46.875 Hz 的頻率格點下，走路 1.5 m/s 在 19 kHz 偏移約 83 Hz（將近 2 個 bin），解碼會失敗。
  4. 頻率直接切換，沒有連續相位與滑音，會產生寬頻的「喀喀」洩漏（我們在 benchmarks 中實測其 18 kHz 以下的洩漏能量）。
- **借鏡**：以 FFT bin 為頻率格點的思路（我們的都卜勒頻偏搜尋也用 FFT bin 作步長）；依長度調整 ECC 位元組數。

## 3. quiet.js（底層 liquid-dsp）

**來源**：[quiet-js README](https://github.com/quiet/quiet-js)、[Quiet profiles 文件](https://quiet.github.io/docs/quiet/profiles)、[quiet-profiles.json](https://raw.githubusercontent.com/quiet/quiet-js/master/quiet-profiles.json)。

- **架構**：以 Emscripten 把 C 函式庫 libquiet（liquid-dsp ＋ libfec ＋ jansson）編譯成 JS。調變參數全部寫在 `quiet-profiles.json` 的 profile 中。
- **與我們相關的 profile**：

  | profile | 調變 | 中心頻率 | 內層 FEC | 外層 FEC | 檢查碼 |
  |---|---|---|---|---|---|
  | ultrasonic | GMSK | 19000 Hz | v27 迴旋碼 | 無 | CRC32 |
  | ultrasonic-whisper | GMSK | 19500 Hz | v27 | 無 | CRC32 |
  | ultrasonic-fsk | FSK16 | 19000 Hz | 無 | v29 | CRC32 |
  | ultrasonic-fsk-robust | FSK8 | 19000 Hz | 無 | v29 | CRC32 |
  | ultrasonic-experimental | BPSK | 19000 Hz | RS8 | v29 | CRC32 |
  | ultrasonic-3600 | OFDM（64 子載波） | 18500 Hz | v27 | 無 | CRC8 |
- **錯誤更正**：迴旋碼（v27、v29，Viterbi 軟解碼）與 Reed-Solomon 由 libfec 提供，可組成內外兩層。
- **瀏覽器支援**（README 表格）：Firefox 會把麥克風輸入重新取樣到 32 kHz，只剩 16 kHz 以下，所以**無法接收超音波 profile**；Safari／iOS Safari 標示「receiver not supported」（README 的理由是當時 Safari 不支援 `getUserMedia`）。Android Chrome 只支援 GMSK profile 的接收。
- **優點**：調變方式完整、迴旋碼＋Viterbi 軟解碼在白噪音下非常有效率；GMSK 頻寬窄、相位連續，洩漏低。
- **缺點／我們可以超越的地方**：
  1. 相位調變（GMSK、PSK）需要精確的載波與時脈同步，在強回音的車站（0.4～1.2 s 殘響）與手機移動時很脆弱；FSK 只看能量，不需相位同步，對多路徑與都卜勒更穩健。
  2. 以 WASM 包裝 C 函式庫，Web Worker 中的除錯與客製（例如我們的頻偏搜尋、重送合併）不易。
  3. README 中 Safari 不支援接收、專案多年沒有更新；本專案以純 TypeScript 實作，iOS Safari 14.1+ 的 AudioWorklet 可以直接使用。
- **借鏡／評估**：內層迴旋碼的軟解碼。評估結論：我們的封包只有 8 bytes，加上 rate-1/2 迴旋碼會讓封包從 2.4 秒變成約 4.3 秒，違反「3 秒內」的需求；改採同樣利用軟資訊、但不增加封包長度的「軟判決＋RS 抹除解碼」（見 benchmarks）。

## 4. Yamaha SoundUD（おもてなしガイド）

**來源**：[Yamaha 新聞稿 2024/04/11](https://www.yamaha.com/ja/news_release/2024/24041101/)、[Yamaha 新聞稿 2022/07/07](https://www.yamaha.com/ja/news_release/2022/22070701/)、[總務省資料](https://www.soumu.go.jp/main_content/000945231.pdf)、[Yamaha 專利 US 10,499,170](https://patents.justia.com/patent/10499170)、[Gizmodo Japan 報導](https://www.gizmodo.jp/2022/07/yamaha-soundud.html)。

- **概念**：「音のユニバーサルデザイン」——讓有聲音的空間與資訊服務連結。2017 年由 Yamaha 號召成立「SoundUD 推進コンソーシアム」推動共通規格。
- **おもてなしガイド**：把車站、機場、設施的廣播文字化與多語化，手機 App 偵測到對應的廣播後顯示內容；利用者不需要特別的硬體。2023 年入選總務省的無障礙優良案例，理由之一是緊急時能透過手機傳遞資訊。
- **技術推測**：Yamaha 專利描述「從第一頻帶的聲音中取出識別資訊，產生在更高的第二頻帶中攜帶該資訊的訊號」；也就是**送的是 ID，內容由 App 依 ID 對應**。我們查到的公開資料**沒有寫明實際使用的頻帶、調變與錯誤更正方式**，因此本文不臆測具體數值。
- **與本專案的差異**：
  1. SoundUD 是商業授權的封閉規格，需要專用 App；本專案是免安裝的網頁（PWA），規格與程式全部公開。
  2. 本專案除了模板 ID 之外，也能送最多 44 bytes 的自由文字，突發狀況不必事先建立模板。
  3. 本專案的模板庫存在手機裡，**完全離線**；並以封包內的月台欄位＋聲音的位置特性做「月台自動判斷」。
- **借鏡**：「只送 ID、內容在手機端」的設計，正是我們「模板＋參數」的做法，可把封包壓到 8 bytes、約 2.4 秒。

## 5. 對本專案設計的影響

| 設計決策 | 依據 |
|---|---|
| 頻段放在 19.5 kHz 以上、單音 FSK | ggwave 從 15 kHz 起、多音分散功率；單音能把全部功率集中在一個頻道 |
| 連續相位＋升餘弦滑音＋淡入淡出 | 避免 ggwave 式硬切換的寬頻洩漏；16 kHz 以下約 −129 dB 以下（實測見 benchmarks） |
| 前導碼 min() 偵測、不用幾何平均 | PoC 實驗：幾何平均在前導碼只收到一半時誤觸發 |
| FFT 共用＋頻偏搜尋（都卜勒） | 三個方案都沒有處理走動中的接收；我們的頻道間距 50 Hz 比走路的頻偏小 |
| 軟判決＋抹除，而非迴旋碼 | 封包長度限制（3 秒內）；迴旋碼 rate 1/2 會讓封包加長約 80% |
| 重送合併 | 站務端本來就會送兩次（叮咚＋語音後再送一次），合併不需要額外的空中時間 |
| 純 TypeScript、不依賴 WASM | 方便在 Worker 中客製、除錯，也方便日後用 Capacitor 包成 App |
