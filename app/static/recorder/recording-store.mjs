const DB_NAME = 'vibe-personal-recordings';
let libraryDatabase;

function openLibrary() {
  if (libraryDatabase) return libraryDatabase;
  libraryDatabase = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('这个浏览器无法保存录音库，请使用普通模式的 Chrome 或 Edge。')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('recordings', {keyPath:'id'});
      db.createObjectStore('content', {keyPath:'id'});
    };
    request.onerror = () => reject(request.error || new Error('无法打开录音库。'));
    request.onblocked = () => reject(new Error('录音库正被旧页面占用，请关闭旧页面后重试。'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); libraryDatabase = null; };
      resolve(db);
    };
  }).catch(error => { libraryDatabase = null; throw error; });
  return libraryDatabase;
}

function transactionResult(transaction, result) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(result());
    transaction.onabort = () => reject(transaction.error || new Error('录音库操作未完成。'));
    transaction.onerror = () => {}; // The abort handler reports the final error.
  });
}

export async function listRecordings() {
  const db = await openLibrary();
  const transaction = db.transaction('recordings','readonly');
  const request = transaction.objectStore('recordings').getAll();
  return transactionResult(transaction, () => request.result.sort((a,b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)));
}

export async function readRecording(id) {
  const db = await openLibrary();
  const transaction = db.transaction(['recordings','content'],'readonly');
  const metadata = transaction.objectStore('recordings').get(id);
  const content = transaction.objectStore('content').get(id);
  const data = await transactionResult(transaction, () => ({metadata:metadata.result,content:content.result}));
  if (!data.metadata || !data.content?.blob || data.content.blob.size !== data.metadata.bytes) {
    throw new Error('这段录音的数据不完整，无法播放；其他录音仍保留在录音库中。');
  }
  return {...data.metadata,blob:data.content.blob,peaks:data.content.peaks || []};
}

export async function saveRecording(metadata, blob, peaks) {
  const db = await openLibrary();
  const transaction = db.transaction(['recordings','content'],'readwrite');
  transaction.objectStore('recordings').put(metadata);
  transaction.objectStore('content').put({id:metadata.id,blob,peaks});
  await transactionResult(transaction, () => undefined);
  // Only report saved after commit AND an independent read of the full take.
  const verified = await readRecording(metadata.id);
  const header = new DataView(await verified.blob.slice(0,44).arrayBuffer());
  if (header.byteLength !== 44 || header.getUint32(0,false) !== 0x52494646 || header.getUint32(8,false) !== 0x57415645) {
    throw new Error('录音保存后的 WAV 校验失败，请先下载本次录音。');
  }
  return verified;
}
