import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './style.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const $ = (id) => document.getElementById(id);
const DB_NAME = 'notenest-local';
const STORE = 'records';
let db, notes = [], folders = [], currentId = null, currentFilter = 'all', currentFolder = null;
let mode = 'text', pdfDoc = null, pdfPage = 1, pdfBytes = null, currentPdfName = '';
let strokes = [], redoStack = [], drawing = false, activeStroke = null, saveTimer, toastTimer, sortNewest = true;
let imageAttachments = [];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function dbPut(item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
function dbAll() {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const now = () => new Date().toISOString();
function toast(message) {
  $('toast').textContent = message; $('toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
}
function safeText(v='') { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function titleFor(n) { return n.title?.trim() || (n.kind === 'pdf' ? n.pdfName || 'PDF document' : 'Untitled note'); }
function defaultNote(kind='note') {
  return { id: uid(), kind, title: '', body: '', createdAt: now(), updatedAt: now(), starred: false, folderId: currentFolder || '', template: 'plain', strokes: [], images: [], pdfData: null, pdfName: '', pdfPage: 1, pdfAnnotations: {} };
}
async function refresh() { notes = (await dbAll()).filter(x => x.recordType !== 'folder'); folders = (await dbAll()).filter(x => x.recordType === 'folder'); renderFolders(); renderLibrary(); }
function renderFolders() {
  $('folderList').innerHTML = folders.map(f => `<button class="nav-item folder-item ${currentFolder===f.id?'active':''}" data-folder="${f.id}">▰ ${safeText(f.name)} <span class="count">${notes.filter(n=>n.folderId===f.id).length}</span><span class="folder-menu" data-folder-menu="${f.id}" title="Rename/delete folder">⋯</span></button>`).join('');
  $('allCount').textContent = notes.length;
}
function filteredNotes() {
  const q = $('searchInput').value.trim().toLowerCase();
  let list = [...notes];
  if (currentFilter === 'starred') list = list.filter(n => n.starred);
  if (currentFilter === 'pdf') list = list.filter(n => n.kind === 'pdf');
  if (currentFilter === 'handwritten') list = list.filter(n => (n.strokes || []).length > 0);
  if (currentFolder) list = list.filter(n => n.folderId === currentFolder);
  if (q) list = list.filter(n => `${titleFor(n)} ${n.body||''} ${n.pdfName||''}`.toLowerCase().includes(q));
  list.sort((a,b) => sortNewest ? b.updatedAt.localeCompare(a.updatedAt) : titleFor(a).localeCompare(titleFor(b)));
  return list;
}
function renderLibrary() {
  const list = filteredNotes();
  $('libraryTitle').textContent = currentFolder ? (folders.find(f=>f.id===currentFolder)?.name || 'Folder') : ({all:'All notes',starred:'Starred',pdf:'PDF documents',handwritten:'Handwritten'}[currentFilter] || 'All notes');
  $('librarySubtitle').textContent = $('searchInput').value.trim() ? `${list.length} result(s) found` : 'Your thoughts, all in one place.';
  $('notesGrid').innerHTML = list.map(n => {
    const snippet = n.kind === 'pdf' ? `PDF · ${n.pdfName || 'Document'}` : ((n.body || '').replace(/\s+/g,' ').slice(0,140) || 'An empty page, ready for your ideas.');
    const date = new Date(n.updatedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'});
    return `<article class="note-card" data-open="${n.id}">
      <div class="card-top"><span class="kind-chip">${n.kind==='pdf'?'PDF':(n.strokes?.length?'✎ Handwritten':'NOTE')}</span><button class="card-star ${n.starred?'is-starred':''}" data-star="${n.id}" title="Star">${n.starred?'★':'☆'}</button></div>
      <h3>${safeText(titleFor(n))}</h3><p>${safeText(snippet)}</p>
      ${n.images?.length ? `<div class="attachment-count">▧ ${n.images.length} image(s)</div>` : ''}
      <div class="card-bottom"><span>${date}</span><button data-move="${n.id}" class="move-link">Move ↗</button></div>
    </article>`;
  }).join('');
  $('emptyState').classList.toggle('visible', list.length===0);
  $('notesGrid').classList.toggle('hidden', list.length===0);
}
async function newNote(kind='note') {
  const n = defaultNote(kind); await dbPut(n); await refresh(); openNote(n.id);
}
async function openNote(id) {
  currentId = id;
  const n = notes.find(x=>x.id===id) || (await dbAll()).find(x=>x.id===id);
  if (!n) return;
  $('libraryView').classList.add('hidden'); $('editorView').classList.remove('hidden');
  $('noteTitle').value = n.title || '';
  $('noteBody').value = n.body || '';
  $('starBtn').textContent = n.starred ? '★' : '☆';
  $('starBtn').classList.toggle('is-starred', !!n.starred);
  $('templateSelect').value = n.template || 'plain';
  $('paper').className = `paper template-${n.template || 'plain'}`;
  strokes = structuredClone(n.strokes || []); redoStack = [];
  imageAttachments = structuredClone(n.images || []);
  $('documentMeta').innerHTML = n.kind === 'pdf' ? `PDF document · ${safeText(n.pdfName || '')}` : (n.folderId ? `Folder: ${safeText(folders.find(f=>f.id===n.folderId)?.name || 'Unknown')}` : 'Personal note');
  $('noteBody').classList.toggle('hidden', n.kind === 'pdf');
  $('inkCanvas').classList.toggle('hidden', n.kind === 'pdf');
  $('editorTools').classList.toggle('hidden', n.kind === 'pdf');
  $('pdfControls').classList.toggle('hidden', n.kind !== 'pdf');
  $('pageStage').classList.toggle('pdf-stage', n.kind === 'pdf');
  if (n.kind === 'pdf') {
    pdfBytes = n.pdfData ? new Uint8Array(n.pdfData) : null; currentPdfName = n.pdfName || 'document.pdf';
    if (pdfBytes) { try { pdfDoc = await pdfjsLib.getDocument({data: pdfBytes}).promise; pdfPage = Math.min(n.pdfPage || 1, pdfDoc.numPages); await renderPdfPage(n); } catch(e) { toast('Could not open this PDF. Try importing it again.'); } }
    else { $('paper').innerHTML = '<p class="pdf-placeholder">This PDF has no locally stored data. Import it again to annotate.</p>'; }
  } else {
    $('paper').innerHTML = '<textarea id="noteBody" class="note-body" placeholder="Start writing…&#10;&#10;Switch to Pen to draw on the page."></textarea><canvas id="inkCanvas"></canvas>';
    $('noteBody').value = n.body || ''; $('noteBody').addEventListener('input', scheduleSave);
    $('inkCanvas').addEventListener('pointerdown', startStroke);
    $('inkCanvas').addEventListener('pointermove', moveStroke);
    $('inkCanvas').addEventListener('pointerup', endStroke);
    $('inkCanvas').addEventListener('pointercancel', endStroke);
    $('inkCanvas').addEventListener('pointerleave', endStroke);
    resizeCanvas(); drawStrokes();
    setMode(mode);
    renderImages();
  }
  $('saveStatus').textContent = 'Saved locally';
}
async function renderPdfPage(n) {
  if (!pdfDoc) return;
  const page = await pdfDoc.getPage(pdfPage);
  const viewport = page.getViewport({scale: 1.45});
  $('paper').innerHTML = '<canvas id="pdfCanvas"></canvas><canvas id="pdfInkCanvas"></canvas>';
  const canvas = $('pdfCanvas'), ctx = canvas.getContext('2d');
  canvas.width = viewport.width; canvas.height = viewport.height;
  canvas.style.width = '100%'; canvas.style.height = 'auto';
  await page.render({canvasContext:ctx, viewport}).promise;
  const ink = $('pdfInkCanvas'); ink.width = viewport.width; ink.height = viewport.height;
  ink.style.width='100%'; ink.style.height='100%';
  const nNow = notes.find(x=>x.id===currentId);
  const pageStrokes = nNow?.pdfAnnotations?.[pdfPage] || [];
  drawOnCanvas(ink, pageStrokes);
  ink.style.position='absolute'; ink.style.inset='0'; ink.style.touchAction='none';
  ink.addEventListener('pointerdown', e => { if(mode==='text') return; drawing=true; ink.setPointerCapture(e.pointerId); const r=ink.getBoundingClientRect(); activeStroke={mode, color:$('inkColor').value, size:Number($('inkSize').value), points:[{x:(e.clientX-r.left)*ink.width/r.width,y:(e.clientY-r.top)*ink.height/r.height}]}; pageStrokes.push(activeStroke); });
  ink.addEventListener('pointermove', e => { if(!drawing||!activeStroke)return; const r=ink.getBoundingClientRect(); activeStroke.points.push({x:(e.clientX-r.left)*ink.width/r.width,y:(e.clientY-r.top)*ink.height/r.height}); drawOnCanvas(ink,pageStrokes); });
  ink.addEventListener('pointerup',()=>{drawing=false;activeStroke=null;scheduleSave();});
  ink.addEventListener('pointercancel',()=>{drawing=false;activeStroke=null;scheduleSave();});
  $('pageCounter').textContent=`Page ${pdfPage} / ${pdfDoc.numPages}`;
}
function drawOnCanvas(canvas, list) {
  const c=canvas.getContext('2d'); c.clearRect(0,0,canvas.width,canvas.height);
  for(const s of list){ if(!s.points?.length)continue; c.beginPath(); c.lineCap='round'; c.lineJoin='round'; c.moveTo(s.points[0].x,s.points[0].y); for(const p of s.points.slice(1)) c.lineTo(p.x,p.y);
    c.globalCompositeOperation=s.mode==='eraser'?'destination-out':'source-over'; c.strokeStyle=s.mode==='highlighter'?'#f4d84b':s.color||'#29243d'; c.globalAlpha=s.mode==='highlighter'?.35:1; c.lineWidth=s.mode==='eraser'?s.size*4:s.size; c.stroke();
  } c.globalAlpha=1; c.globalCompositeOperation='source-over';
}
function resizeCanvas() {
  const canvas=$('inkCanvas'); if(!canvas || !currentId)return;
  const rect=$('paper').getBoundingClientRect(); if(!rect.width)return;
  const ratio=window.devicePixelRatio||1; canvas.width=rect.width*ratio; canvas.height=Math.max(rect.height,700)*ratio;
  canvas.style.width='100%'; canvas.style.height=`${Math.max(rect.height,700)}px`;
  drawStrokes();
}
function drawStrokes(){ const c=$('inkCanvas'); if(c)drawOnCanvas(c,strokes); }
function startStroke(e) {
  if(mode==='text')return;
  e.preventDefault(); const c=$('inkCanvas'); c.setPointerCapture(e.pointerId); drawing=true;
  const r=c.getBoundingClientRect(), ratioX=c.width/r.width, ratioY=c.height/r.height;
  activeStroke={mode,color:$('inkColor').value,size:Number($('inkSize').value),points:[{x:(e.clientX-r.left)*ratioX,y:(e.clientY-r.top)*ratioY}]}; strokes.push(activeStroke); redoStack=[]; drawStrokes();
}
function moveStroke(e) {
  if(!drawing||!activeStroke)return; e.preventDefault(); const c=$('inkCanvas'),r=c.getBoundingClientRect();
  activeStroke.points.push({x:(e.clientX-r.left)*c.width/r.width,y:(e.clientY-r.top)*c.height/r.height}); drawStrokes();
}
function endStroke(){ if(drawing){drawing=false;activeStroke=null;scheduleSave();} }
function setMode(m) {
  mode=m; document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===m));
  const c=$('inkCanvas'); if(c)c.style.pointerEvents=m==='text'?'none':'auto';
  if($('noteBody'))$('noteBody').style.pointerEvents=m==='text'?'auto':'none';
}
function scheduleSave() {
  $('saveStatus').textContent='Saving…'; clearTimeout(saveTimer); saveTimer=setTimeout(saveCurrent,450);
}
async function saveCurrent() {
  if(!currentId)return;
  const all=await dbAll(), n=all.find(x=>x.id===currentId); if(!n)return;
  n.title=$('noteTitle').value; n.updatedAt=now(); n.template=$('templateSelect').value;
  if(n.kind!=='pdf') { n.body=$('noteBody')?.value || ''; n.strokes=structuredClone(strokes); n.images=structuredClone(imageAttachments); }
  else { n.pdfPage=pdfPage; }
  await dbPut(n); $('saveStatus').textContent='Saved locally'; await refresh();
}
function renderImages() {
  let old=$('imageStrip'); if(old)old.remove();
  if(!imageAttachments.length)return;
  const strip=document.createElement('div'); strip.id='imageStrip'; strip.className='image-strip';
  strip.innerHTML=imageAttachments.map((img,i)=>`<div class="image-thumb"><img src="${img.data}" alt="${safeText(img.name)}"><button data-remove-image="${i}" title="Remove image">×</button></div>`).join('');
  $('pageStage').appendChild(strip);
}
async function addImage(file) {
  if(!file || !currentId)return;
  const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});
  imageAttachments.push({name:file.name,data}); renderImages(); scheduleSave(); toast('Image added');
}
async function renderPdfIntoNewNote(file) {
  const bytes=new Uint8Array(await file.arrayBuffer());
  const n=defaultNote('pdf'); n.title=file.name.replace(/\.pdf$/i,''); n.pdfName=file.name; n.pdfData=Array.from(bytes); n.pdfAnnotations={}; n.createdAt=now(); n.updatedAt=now();
  await dbPut(n); await refresh(); await openNote(n.id);
}
function downloadBlob(blob,name) {
  const url=URL.createObjectURL(blob), a=document.createElement('a'); a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
}
async function exportCurrent() {
  await saveCurrent(); const n=(await dbAll()).find(x=>x.id===currentId); if(!n)return;
  if(n.kind==='pdf'&&n.pdfData){downloadBlob(new Blob([new Uint8Array(n.pdfData)],{type:'application/pdf'}),`${titleFor(n)}-original.pdf`);toast('Original PDF exported. Annotations remain in the NoteNest backup.');return;}
  const text=`# ${titleFor(n)}\n\n${n.body||''}\n\n${(n.images||[]).map(i=>`[Image attachment: ${i.name}]`).join('\n')}`;
  downloadBlob(new Blob([text],{type:'text/markdown;charset=utf-8'}),`${(titleFor(n)||'note').replace(/[^\w-]+/g,'_')}.md`);
}
async function exportBackup() {
  const all=await dbAll();
  downloadBlob(new Blob([JSON.stringify({app:'NoteNest',version:1,exportedAt:now(),records:all},null,2)],{type:'application/json'}),'notenest-backup.json');
  toast('Backup exported');
}
async function importBackup(file) {
  try { const data=JSON.parse(await file.text()); if(!Array.isArray(data.records))throw new Error('Invalid backup'); for(const r of data.records)if(r.id)await dbPut(r); await refresh(); toast('Backup imported'); }
  catch(e){toast('Could not import this backup');}
}
function escapeFileName(s){return (s||'note').replace(/[^\w-]+/g,'_').slice(0,70)||'note';}

$('newNoteBtn').onclick=()=>newNote(); $('emptyNewBtn').onclick=()=>newNote();
$('backBtn').onclick=async()=>{await saveCurrent();currentId=null;$('editorView').classList.add('hidden');$('libraryView').classList.remove('hidden');renderLibrary();};
$('noteTitle').addEventListener('input',scheduleSave); $('noteBody').addEventListener('input',scheduleSave);
$('searchInput').addEventListener('input',renderLibrary);
$('themeBtn').onclick=()=>{document.documentElement.classList.toggle('dark');localStorage.setItem('notenest-theme',document.documentElement.classList.contains('dark')?'dark':'light');};
if(localStorage.getItem('notenest-theme')==='dark')document.documentElement.classList.add('dark');
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{currentFilter=b.dataset.filter;currentFolder=null;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));renderFolders();renderLibrary();});
$('addFolderBtn').onclick=()=>{$('folderName').value='';$('folderDialog').showModal();$('folderName').focus();};
$('folderForm').addEventListener('submit',async e=>{if(e.submitter?.value!=='create')return;e.preventDefault();const name=$('folderName').value.trim();if(!name)return;await dbPut({id:uid(),recordType:'folder',name,createdAt:now()});$('folderDialog').close();await refresh();toast('Folder created');});
$('folderList').addEventListener('click',async e=>{
  const menu=e.target.closest('[data-folder-menu]'); if(menu){e.stopPropagation();const id=menu.dataset.folderMenu;const f=folders.find(x=>x.id===id);const action=prompt(`Folder: ${f.name}\nType a new name to rename, or DELETE to remove the folder (notes will be unfiled).`);if(action===null)return;if(action.trim().toUpperCase()==='DELETE'){await dbDelete(id);for(const n of notes.filter(x=>x.folderId===id)){n.folderId='';await dbPut(n);}if(currentFolder===id)currentFolder=null;}else if(action.trim()){f.name=action.trim();await dbPut(f);}await refresh();return;}
  const b=e.target.closest('[data-folder]');if(b){currentFolder=b.dataset.folder;currentFilter='all';document.querySelectorAll('[data-filter]').forEach(x=>x.classList.remove('active'));renderFolders();renderLibrary();}
});
$('notesGrid').addEventListener('click',async e=>{
  const star=e.target.closest('[data-star]');if(star){const n=notes.find(x=>x.id===star.dataset.star);n.starred=!n.starred;n.updatedAt=now();await dbPut(n);await refresh();return;}
  const move=e.target.closest('[data-move]');if(move){const n=notes.find(x=>x.id===move.dataset.move);$('moveFolderSelect').innerHTML='<option value="">Unfiled</option>'+folders.map(f=>`<option value="${f.id}">${safeText(f.name)}</option>`).join('');$('moveFolderSelect').value=n.folderId||'';$('moveForm').dataset.noteId=n.id;$('folderMoveDialog').showModal();return;}
  const card=e.target.closest('[data-open]');if(card)openNote(card.dataset.open);
});
$('moveForm').addEventListener('submit',async e=>{if(e.submitter?.value!=='move')return;e.preventDefault();const n=notes.find(x=>x.id===$('moveForm').dataset.noteId);if(n){n.folderId=$('moveFolderSelect').value;n.updatedAt=now();await dbPut(n);await refresh();}$('folderMoveDialog').close();});
$('sortBtn').onclick=()=>{sortNewest=!sortNewest;$('sortBtn').textContent=sortNewest?'Recently edited ↓':'Title A–Z';renderLibrary();};
$('importPdfBtn').onclick=()=>$('pdfFile').click(); $('pdfFile').onchange=async e=>{const f=e.target.files[0];if(f)await renderPdfIntoNewNote(f);e.target.value='';};
$('importImageBtn').onclick=()=>{if(!currentId){toast('Open or create a note first');newNote();setTimeout(()=>$('imageFile').click(),300);}else $('imageFile').click();};
$('addImageEditorBtn').onclick=()=>$('imageFile').click();
$('imageFile').onchange=async e=>{const f=e.target.files[0];if(f)await addImage(f);e.target.value='';};
$('editorTools').addEventListener('click',e=>{const b=e.target.closest('[data-mode]');if(b)setMode(b.dataset.mode);});
$('inkColor').oninput=()=>{}; $('inkSize').oninput=()=>{};
$('templateSelect').onchange=()=>{$('paper').className=`paper template-${$('templateSelect').value}`;scheduleSave();};
$('undoBtn').onclick=()=>{if(strokes.length){redoStack.push(strokes.pop());drawStrokes();scheduleSave();}};
$('redoBtn').onclick=()=>{if(redoStack.length){strokes.push(redoStack.pop());drawStrokes();scheduleSave();}};
$('starBtn').onclick=async()=>{const n=(await dbAll()).find(x=>x.id===currentId);if(!n)return;n.starred=!n.starred;await dbPut(n);$('starBtn').textContent=n.starred?'★':'☆';$('starBtn').classList.toggle('is-starred',n.starred);await refresh();};
$('deleteNoteBtn').onclick=async()=>{if(!currentId)return;if(confirm('Delete this note permanently from this device?')){await dbDelete(currentId);currentId=null;$('editorView').classList.add('hidden');$('libraryView').classList.remove('hidden');await refresh();toast('Note deleted');}};
$('exportNoteBtn').onclick=exportCurrent;
$('exportAllBtn').onclick=exportBackup;
$('importBackupBtn').onclick=()=>$('backupFile').click();
$('backupFile').onchange=async e=>{const f=e.target.files[0];if(f)await importBackup(f);e.target.value='';};
$('pageStage').addEventListener('click',e=>{const b=e.target.closest('[data-remove-image]');if(b){imageAttachments.splice(Number(b.dataset.removeImage),1);renderImages();scheduleSave();}});
$('prevPageBtn').onclick=async()=>{if(pdfDoc&&pdfPage>1){pdfPage--;await renderPdfPage(notes.find(x=>x.id===currentId));scheduleSave();}};
$('nextPageBtn').onclick=async()=>{if(pdfDoc&&pdfPage<pdfDoc.numPages){pdfPage++;await renderPdfPage(notes.find(x=>x.id===currentId));scheduleSave();}};
$('menuBtn').onclick=()=>$('sidebar').classList.toggle('sidebar-open');
window.addEventListener('resize',()=>{if(currentId && !$('editorView').classList.contains('hidden') && !pdfDoc)resizeCanvas();});
window.addEventListener('beforeunload',()=>{if(currentId)saveCurrent();});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveCurrent();}if(e.key==='Escape')$('sidebar').classList.remove('sidebar-open');});

async function init() {
  db=await openDB(); await refresh();
  if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
  if(!notes.length) $('emptyState').classList.add('visible');
}
init().catch(e=>{console.error(e);toast('Could not initialize local storage');});
