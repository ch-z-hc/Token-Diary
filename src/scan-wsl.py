"""Read only Codex records in WSL; no Node installation or credentials required."""
import pathlib,json,hashlib,datetime,gzip,base64,re,collections,ctypes,io,os
from zoneinfo import ZoneInfo
SETTINGS=json.loads(os.environ.get("AI_LOG_SCAN_OPTIONS","{}"))
TIMEZONE=SETTINGS.get("timezone","Asia/Shanghai")

def day(ts):
    try:return datetime.datetime.fromisoformat(ts.replace('Z','+00:00')).astimezone(ZoneInfo(TIMEZONE)).strftime('%Y-%m-%d')
    except:return None

def usage(u):return {k:int(u.get(v,0) or 0) for k,v in [('input','input_tokens'),('cached','cached_input_tokens'),('cacheWrite','cache_write_input_tokens'),('output','output_tokens'),('reasoning','reasoning_output_tokens')]}
def sig(u):return ':'.join(str(u[k]) for k in ['input','cached','cacheWrite','output','reasoning'])
def digest(x):return hashlib.sha256(json.dumps(x,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def clean(t):
    t=re.sub(r'-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [^-]+-----|$)','[已隐去凭据]',str(t or ''))
    t=re.sub(r'<(environment_context|INSTRUCTIONS|system-reminder|user_instructions|external_codex_apps_open_page|send_user_message_question_reply)>[\s\S]*?</\1>','',t,flags=re.I)
    t=re.sub(r'^# AGENTS\.md instructions[\s\S]*','',t,flags=re.M)
    t=re.sub(r'```[\s\S]*?```','',t)
    t=re.sub(r'(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}','[已隐去凭据]',t)
    t=re.sub(r'((?:password|api[_-]?key|secret|token|口令|密码)\s*[=:：]\s*)[^\s,，;；]+',r'\1[已隐去]',t,flags=re.I)
    t=re.sub(r'https?://[^\s<]+','[链接]',t);t=re.sub(r'<[^>]+>','',t)
    return re.sub(r'\s+',' ',t).strip()[:1400]
def ignorable_line(line):
    return not line.strip() or bool(re.search(r'"type"\s*:\s*"event_msg"\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"task_started"\s*[,}]',line)) and not re.search(r'token_usage_record|token_count|"usage"\s*:',line)
def parse(file,include_text=None):
    if include_text is None:include_text=SETTINGS.get("captureText",False)
    sid=file.stem;model='unknown';cwd='';events=[];counters=[];modern=set();modern_calls=[];prev=None;messages=[];malformed=0
    if file.suffix=='.zst':
        raw=file.read_bytes();lib=ctypes.CDLL('libzstd.so.1')
        lib.ZSTD_getFrameContentSize.argtypes=[ctypes.c_void_p,ctypes.c_size_t];lib.ZSTD_getFrameContentSize.restype=ctypes.c_ulonglong
        size=lib.ZSTD_getFrameContentSize(raw,len(raw))
        if size>512*1024*1024:
            lib.ZSTD_decompressBound.argtypes=[ctypes.c_void_p,ctypes.c_size_t];lib.ZSTD_decompressBound.restype=ctypes.c_ulonglong
            size=lib.ZSTD_decompressBound(raw,len(raw))
        if size>512*1024*1024:raise RuntimeError('zstd-size-unknown')
        out=ctypes.create_string_buffer(size)
        lib.ZSTD_decompress.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_void_p,ctypes.c_size_t];lib.ZSTD_decompress.restype=ctypes.c_size_t
        n=lib.ZSTD_decompress(out,size,raw,len(raw))
        if n>size:raise RuntimeError('zstd-decode-failed')
        stream=io.StringIO(out.raw[:n].decode())
    else:stream=file.open(encoding='utf-8')
    with stream:
        for line in stream:
            try:r=json.loads(line)
            except json.JSONDecodeError:
                if not ignorable_line(line):malformed+=1
                continue
            p=r.get('payload') or {};ts=r.get('timestamp');typ=r.get('type')
            if typ=='session_meta':sid=p.get('id') or p.get('session_id') or sid;cwd=p.get('cwd','')
            if typ=='turn_context':model=p.get('model',model)
            if typ=='token_usage_record' and p.get('usage'):
                u=usage(p['usage']);modern_calls.append((datetime.datetime.fromisoformat(ts.replace('Z','+00:00')),sig(u)));modern.add(sig(usage(p.get('thread_token_usage') or {})))
                events.append(dict(id='response:'+p['response_id'] if p.get('response_id') else 'record:'+digest([ts,p['usage']]),ts=ts,day=day(ts),agent='Codex',session=p.get('thread_id') or sid,model=model,**u))
            if typ=='event_msg' and p.get('type')=='token_count' and (p.get('info') or {}).get('total_token_usage'):
                total=usage(p['info']['total_token_usage']);s=sig(total)
                if prev is None or s!=sig(prev):
                    last=usage(p['info']['last_token_usage']) if p['info'].get('last_token_usage') else None
                    u=last if prev is None and last else {k:max(0,total[k]-(prev or {}).get(k,0)) for k in total}
                    counters.append(dict(id='counter:'+digest([ts,s]),ts=ts,day=day(ts),agent='Codex',session=sid,model=model,signature=s,lastSignature=sig(last) if last else None,**u));prev=total
            text='';role=''
            if typ=='response_item' and p.get('type')=='message' and p.get('role') in ['user','assistant']:
                c=p.get('content') or [];text=c if isinstance(c,str) else '\n'.join(x.get('text','') for x in c if x.get('type') in ['text','input_text','output_text']);role=p['role']
            if typ=='event_msg' and p.get('type') in ['user_message','task_complete']:text=p.get('message') or p.get('last_agent_message') or '';role='user' if p['type']=='user_message' else 'assistant'
            text=clean(text) if include_text else ""
            if text and day(ts):messages.append((day(ts),role,text))
    for e in counters:
        signature=e.pop('signature');last=e.pop('lastSignature');dt=datetime.datetime.fromisoformat(e['ts'].replace('Z','+00:00'))
        if signature not in modern and not any(sig==last and abs((time-dt).total_seconds())<60 for time,sig in modern_calls):events.append(e)
    days={}
    for date,role,text in messages:
        d=days.setdefault(date,dict(requests=[],results=[]));a=d['requests'] if role=='user' else d['results']
        if text not in a:a.append(text)
    sessions=[dict(id=sid,agent='Codex',day=date,project=pathlib.Path(cwd).name if include_text else '',requests=d['requests'][:4],results=d['results'][-2:]) for date,d in days.items()]
    return dict(events=[e for e in events if e['day'] and e['input']+e['output']>0],sessions=sessions,malformed=malformed)
def scan():
    home=pathlib.Path(SETTINGS["home"]) if SETTINGS.get("home") else pathlib.Path.home();events=[];sessions=[];errors=[];files=[]
    for name in ['sessions','archived_sessions']:
        root=home/'.codex'/name
        if root.exists():files.extend(p for p in root.rglob('*') if p.is_file() and re.search(r'\.jsonl(?:\.zst)?$',p.name))
    for file in files:
        try:
            data=parse(file);events.extend(data['events']);sessions.extend(data['sessions'])
            if data['malformed']:errors.append(dict(agent='Codex',file=file.name,kind='invalid-json-lines',count=data['malformed']))
        except Exception as e:errors.append(dict(agent='Codex',file=file.name,kind=type(e).__name__))
    inventory=[dict(agent='Codex',files=len(files),events=len(events),status='partial' if errors else 'collected' if files else 'not-found')]
    for agent,folder in [('Claude Code','.claude/projects'),('Pi','.pi/agent/sessions'),('OpenCode','.local/share/opencode'),('Gemini CLI','.gemini/tmp'),('GitHub Copilot','.copilot/session-state'),('Cursor','.cursor/projects'),('Cline','.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev'),('Roo Code','.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline'),('Kilo Code','.vscode-server/data/User/globalStorage/kilocode.kilo-code')]:
        inventory.append(dict(agent=agent,status='unavailable' if (home/folder).exists() else 'not-found'))
    return dict(version=1,timezone=TIMEZONE,captureText=SETTINGS.get("captureText",False),scannedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),events=events,sessions=sessions,inventory=inventory,errors=errors)
if __name__=='__main__':print(base64.b64encode(gzip.compress(json.dumps(scan(),ensure_ascii=False).encode())).decode())
