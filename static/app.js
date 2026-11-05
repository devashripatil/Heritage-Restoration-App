const $ = (id) => document.getElementById(id);
let selectedFile = null, currentRecordId = null, originalUrl = null, restoredUrl = null;
let displayImage = null, maskCtx = null, maskLayer = null, maskLayerCtx = null, drawing = false, maskDirty = false;
let comparisonBeforeUrl = null, comparisonAfterUrl = null, comparisonMode = "both";

const imageInput = $('imageInput'), dropzone = $('dropzone'), canvas = $('maskCanvas');
maskCtx = canvas.getContext('2d', { willReadFrequently: true });
maskLayer = document.createElement('canvas'); maskLayerCtx = maskLayer.getContext('2d', { willReadFrequently: true });
maskLayerCtx.lineCap = 'round'; maskLayerCtx.lineJoin = 'round';
maskCtx.lineCap = 'round'; maskCtx.lineJoin = 'round';

function setMessage(el, text, error=false) { el.textContent = text || ''; el.style.color = error ? '#a65b47' : ''; }
function loadImageFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|bmp)$/.test(file.type)) { alert('Please select a PNG, JPG, WEBP or BMP image.'); return; }
  selectedFile = file; currentRecordId = null; restoredUrl = null; maskDirty = false;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    displayImage = img;
    $('sourcePreview').src = url; $('sourceWrap').classList.remove('hidden');
    $('imageDimensions').textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
    $('analyzeBtn').disabled = false; $('restoreBtn').disabled = true; $('clearMaskBtn').disabled = false;
    $('compareImages').classList.add('hidden'); $('analysisResult').classList.add('hidden');
    $('maskPlaceholder').classList.add('hidden'); $('restoreMessage').textContent = '';
    const ratio = img.naturalWidth / img.naturalHeight;
    const maxW = 1000, maxH = 650;
    let w = Math.min(maxW, img.naturalWidth), h = w / ratio;
    if (h > maxH) { h = maxH; w = h * ratio; }
    canvas.width = Math.max(1, Math.round(w)); canvas.height = Math.max(1, Math.round(h));
    maskLayer.width = canvas.width; maskLayer.height = canvas.height;
    maskCtx.clearRect(0,0,canvas.width,canvas.height); maskCtx.drawImage(img,0,0,canvas.width,canvas.height);
    maskLayerCtx.clearRect(0,0,maskLayer.width,maskLayer.height);
    updateComparison(originalUrl || url, null);
  };
  img.src = url;
}
imageInput.addEventListener('change', e => loadImageFile(e.target.files[0]));
['dragenter','dragover'].forEach(ev => dropzone.addEventListener(ev,e=>{e.preventDefault();dropzone.style.borderColor='#496b53';}));
['dragleave','drop'].forEach(ev => dropzone.addEventListener(ev,e=>{e.preventDefault();dropzone.style.borderColor='';}));
dropzone.addEventListener('drop',e=>loadImageFile(e.dataTransfer.files[0]));

$('brushSize').addEventListener('input',e=>$('brushValue').textContent=`${e.target.value} px`);
function canvasPoint(e) { const r=canvas.getBoundingClientRect(); return {x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height}; }
function startDraw(e) { if(!displayImage)return; drawing=true; canvas.setPointerCapture?.(e.pointerId); const p=canvasPoint(e); maskCtx.beginPath();maskCtx.moveTo(p.x,p.y);maskLayerCtx.beginPath();maskLayerCtx.moveTo(p.x,p.y);maskDirty=true; }
function draw(e) { if(!drawing)return; const p=canvasPoint(e); const brush=Number($('brushSize').value)*canvas.width/canvas.getBoundingClientRect().width; maskCtx.strokeStyle='rgba(255,40,35,0.72)'; maskCtx.lineWidth=brush; maskCtx.lineTo(p.x,p.y);maskCtx.stroke(); maskLayerCtx.strokeStyle='white';maskLayerCtx.lineWidth=brush;maskLayerCtx.lineTo(p.x,p.y);maskLayerCtx.stroke(); }
function endDraw(){ if(!drawing)return; drawing=false;maskCtx.closePath();maskLayerCtx.closePath();$('restoreBtn').disabled=!maskDirty; }
canvas.addEventListener('pointerdown',startDraw);canvas.addEventListener('pointermove',draw);canvas.addEventListener('pointerup',endDraw);canvas.addEventListener('pointercancel',endDraw);
$('clearMaskBtn').addEventListener('click',()=>{if(!displayImage)return;maskCtx.clearRect(0,0,canvas.width,canvas.height);maskCtx.drawImage(displayImage,0,0,canvas.width,canvas.height);maskLayerCtx.clearRect(0,0,maskLayer.width,maskLayer.height);maskDirty=false;$('restoreBtn').disabled=true;$('restoreMessage').textContent='Mask cleared. Draw over the damaged areas to continue.';});

$('analyzeBtn').addEventListener('click',async()=>{
  if(!selectedFile)return;
  $('analyzeBtn').disabled=true;$('analyzeBtn').textContent='Analyzing…';
  const fd=new FormData();fd.append('image',selectedFile);
  try{
    const res=await fetch('/api/analyze',{method:'POST',body:fd});const data=await res.json();if(!res.ok)throw new Error(data.error||'Analysis failed');
    currentRecordId=data.id;originalUrl=data.image_url;restoredUrl=null;
    $('sourcePreview').src=originalUrl; $('analysisResult').classList.remove('hidden');
    const conf=data.confidence==null?'Not available':`${data.confidence}%`;
    $('analysisResult').innerHTML=`<strong>${escapeHtml(data.label)}</strong><div class="confidence">${conf}</div><small>${escapeHtml(data.message||'')}</small>${data.damage_score!=null?`<small>Mean damaged score: ${data.damage_score}% · Patch scores: ${data.patch_scores.join(', ')}%</small>`:''}`;
    $('restoreBtn').disabled=!maskDirty;updateComparison(originalUrl,null);refreshHistory();
  }catch(err){$('analysisResult').classList.remove('hidden');$('analysisResult').textContent=err.message;}
  finally{$('analyzeBtn').disabled=false;$('analyzeBtn').innerHTML='Analyze damage <span>↗</span>';}
});

$('restoreBtn').addEventListener('click',async()=>{
  if(!currentRecordId){setMessage($('restoreMessage'),'Analyze the image first so the result can be saved.',true);return;}
  if(!maskDirty){setMessage($('restoreMessage'),'Draw a mask over at least one damaged area.',true);return;}
  $('restoreBtn').disabled=true;$('restoreBtn').textContent='Creating preview…';
  try{
    // Separate mask layer avoids mistaking naturally red pigment in the painting for user strokes.
    const out=document.createElement('canvas');out.width=maskLayer.width;out.height=maskLayer.height;const octx=out.getContext('2d');
    octx.fillStyle='black';octx.fillRect(0,0,out.width,out.height);octx.drawImage(maskLayer,0,0);
    const maskBlob=await new Promise(resolve=>out.toBlob(resolve,'image/png'));const fd=new FormData();fd.append('mask',maskBlob,'mask.png');fd.append('radius','5');
    const res=await fetch(`/api/restore/${currentRecordId}`,{method:'POST',body:fd});const data=await res.json();if(!res.ok)throw new Error(data.error||'Restoration failed');
    restoredUrl=data.restored_url;$('compareBefore').src=originalUrl;$('compareAfter').src=restoredUrl;$('compareImages').classList.remove('hidden');setMessage($('restoreMessage'),data.message);updateComparison(originalUrl,restoredUrl);refreshHistory();
  }catch(err){setMessage($('restoreMessage'),err.message,true);}
  finally{$('restoreBtn').disabled=!maskDirty;$('restoreBtn').innerHTML='Generate restoration preview <span>✳</span>';}
});

function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function refreshHistory(){try{const res=await fetch('/api/history');const rows=await res.json();const list=$('historyList');if(!rows.length){list.innerHTML='<p class="helper">No saved analyses yet.</p>';return;}list.innerHTML=rows.map(r=>`<div class="history-item"><img src="${r.restored_url||r.image_url}" alt=""><div class="history-meta"><strong>${escapeHtml(r.filename)}</strong><small>${escapeHtml(new Date(r.created_at).toLocaleString())}</small></div><div class="history-score">${escapeHtml(r.prediction||'No model')}<br>${r.confidence==null?'':escapeHtml(r.confidence+'%')}</div></div>`).join('');}catch(e){$('historyList').innerHTML='<p class="helper">Could not load history.</p>';}}
$('refreshHistoryBtn').addEventListener('click',refreshHistory);

// Offline 2D before/after comparison. No Three.js, WebGL, or CDN required.
function updateComparison(before, after) {
  comparisonBeforeUrl = before || null;
  comparisonAfterUrl = after || null;
  const host = $('threeViewer');
  const placeholder = $('viewerPlaceholder');
  if (!host) return;

  host.querySelectorAll('.offline-comparison, .viewer-placeholder').forEach(el => {
    if (el !== placeholder) el.remove();
  });

  if (!comparisonBeforeUrl) {
    placeholder.classList.remove('hidden');
    $('comparisonSlider').disabled = true;
    return;
  }

  placeholder.classList.add('hidden');
  const frame = document.createElement('div');
  frame.className = 'offline-comparison';
  frame.setAttribute('aria-label', 'Before and after painting comparison');

  const beforeImg = document.createElement('img');
  beforeImg.className = 'comparison-image comparison-before';
  beforeImg.alt = 'Original damaged painting';
  beforeImg.src = comparisonBeforeUrl;

  const afterLayer = document.createElement('div');
  afterLayer.className = 'comparison-after-layer';
  const afterImg = document.createElement('img');
  afterImg.className = 'comparison-image';
  afterImg.alt = 'Estimated restored painting';
  if (comparisonAfterUrl) afterImg.src = comparisonAfterUrl;
  afterLayer.appendChild(afterImg);

  const beforeLabel = document.createElement('span');
  beforeLabel.className = 'comparison-tag comparison-tag-before';
  beforeLabel.textContent = 'ORIGINAL';
  const afterLabel = document.createElement('span');
  afterLabel.className = 'comparison-tag comparison-tag-after';
  afterLabel.textContent = 'RESTORED PREVIEW';

  const divider = document.createElement('div');
  divider.className = 'comparison-divider';

  frame.append(beforeImg, afterLayer, beforeLabel, afterLabel, divider);
  host.appendChild(frame);

  $('comparisonSlider').disabled = !comparisonAfterUrl;
  $('comparisonSlider').value = 50;
  $('comparisonValue').textContent = '50%';
  comparisonMode = 'both';
  setComparisonMode('both');
  applyComparisonSlider();
}

function applyComparisonSlider() {
  const frame = $('threeViewer').querySelector('.offline-comparison');
  if (!frame) return;
  const slider = $('comparisonSlider');
  const value = Number(slider.value);
  const afterLayer = frame.querySelector('.comparison-after-layer');
  const divider = frame.querySelector('.comparison-divider');
  afterLayer.style.clipPath = `inset(0 0 0 ${value}%)`;
  divider.style.left = `${value}%`;
  $('comparisonValue').textContent = `${value}%`;
}

function setComparisonMode(mode) {
  comparisonMode = mode;
  const frame = $('threeViewer').querySelector('.offline-comparison');
  if (!frame) return;
  const afterLayer = frame.querySelector('.comparison-after-layer');
  const divider = frame.querySelector('.comparison-divider');
  const slider = $('comparisonSlider');
  if (mode === 'before') {
    afterLayer.style.display = 'none';
    divider.style.display = 'none';
    slider.disabled = true;
  } else if (mode === 'after') {
    if (comparisonAfterUrl) {
      afterLayer.style.display = 'block';
      afterLayer.style.clipPath = 'inset(0 0 0 0)';
    } else {
      afterLayer.style.display = 'none';
    }
    divider.style.display = 'none';
    slider.disabled = true;
  } else {
    afterLayer.style.display = comparisonAfterUrl ? 'block' : 'none';
    divider.style.display = comparisonAfterUrl ? 'block' : 'none';
    slider.disabled = !comparisonAfterUrl;
    applyComparisonSlider();
  }
  document.querySelectorAll('.view-mode').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.mode === mode)
  );
}

$('comparisonSlider').addEventListener('input', applyComparisonSlider);
document.querySelectorAll('.view-mode').forEach(btn =>
  btn.addEventListener('click', () => setComparisonMode(btn.dataset.mode))
);
$('resetViewBtn').addEventListener('click', () => {
  $('comparisonSlider').value = 50;
  applyComparisonSlider();
  setComparisonMode('both');
});
window.addEventListener('resize', applyComparisonSlider);

refreshHistory();
