"""Actual surface presentation and gateway tests; no browser security overrides."""
from __future__ import annotations
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PROBE = r"""async () => {
    const {CanvasRenderer} = await import('/RDP/packages/render/CanvasRenderer.js');
    const original = CanvasRenderer.prototype.whenComplete, apply = CanvasRenderer.prototype.apply;
    const p = globalThis.surfaceProbe = {hold:false,gates:[],groups:[],received:0,receipts:0,activeCount:0,states:[],errors:[]};
    CanvasRenderer.prototype.apply = function(rects) {p.groups.push(rects.map(r=>r.encoding||'raw'));return apply.call(this,rects);};
    CanvasRenderer.prototype.whenComplete = function(signal) {
        if(!p.hold)return original.call(this,signal);
        return new Promise((resolve,reject)=>{
            const aborted=()=>reject(new Error('test completion cancelled'));
            signal.addEventListener('abort',aborted,{once:true});
            p.gates.push(()=>{signal.removeEventListener('abort',aborted);resolve();});
        });
    };
    const post=Worker.prototype.postMessage,observed=new WeakSet();
    Worker.prototype.postMessage=function(m,...rest){
        if(!observed.has(this)){observed.add(this);this.addEventListener('message',({data})=>{
            if(data.type==='frame')for(const c of data.commands)if(c.type==='surface-frame')p.received++;
            if(data.type==='state'){p.states.push(data.state);if(data.state==='active')p.activeCount++;}
            if(data.type==='error')p.errors.push({code:data.code,message:data.message});
        });}
        if(m.type==='frame-ack')p.receipts++;
        return post.call(this,m,...rest);
    };
}"""
COMPARE = r"""async () => {
    const {CanvasRenderer}=await import('/RDP/packages/render/CanvasRenderer.js');
    const {WebGlRenderer}=await import('/RDP/packages/render/WebGlRenderer.js');
    const {WebGpuRenderer}=await import('/RDP/packages/render/WebGpuRenderer.js');
    const {decodeNsCodec,nsCodecToRgba}=await import('/RDP/packages/codecs/NsCodec.js');
    const {Writer}=await import('/RDP/packages/binary/Writer.js');
    const results=[];
    for(const [name,Renderer] of [['Canvas',CanvasRenderer],['WebGL2',WebGlRenderer],['WebGPU',WebGpuRenderer]]) {
        const canvas=document.createElement('canvas');document.body.append(canvas);let renderer;
        try { renderer=await Renderer.create(canvas); }
        catch(error){canvas.remove();if(['WEBGPU_UNAVAILABLE','WEBGPU_ADAPTER','WEBGL_UNAVAILABLE'].includes(error.code)){
            results.push({backend:name,available:false,reason:error.message});continue;}throw error;}
        const failures=[];
        if(renderer.device)renderer.device.addEventListener('uncapturederror',e=>failures.push(e.error.message));
        try {
            renderer.resize(40,40);let pixels=0;
            for(const sub of [false,true])for(const alpha of [false,true])for(const bpp of [24,32])for(let loss=1;loss<=7;loss++){
                const w=17,h=17,stride=sub?24:w,cs=sub?12:w,ch=sub?9:h;
                const planes=[new Uint8Array(stride*h),new Uint8Array(cs*ch),new Uint8Array(cs*ch),new Uint8Array(alpha?w*h:0)];
                for(let i=0;i<planes.length;i++)for(let p=0;p<planes[i].length;p++)planes[i][p]=(p*29+i*53)&255;
                const writer=new Writer();for(const p of planes)writer.u32le(p.length);writer.u8(loss).u8(+sub).u16le(0);for(const p of planes)writer.put(p);
                const r={...decodeNsCodec(writer.finish(),w,h,{sourceBpp:bpp}),x:3,y:4,drawWidth:16,drawHeight:15};
                const base={x:0,y:0,width:40,height:40,drawWidth:40,drawHeight:40,stride:160,bpp:32,bottomUp:false,data:new Uint8Array(6400)};
                renderer.apply([base,r]);
                const abort=new AbortController(),timer=setTimeout(()=>abort.abort(new Error('renderer timeout')),12000);
                try{await renderer.whenComplete(abort.signal);}finally{clearTimeout(timer);}
                const actual=await renderer.readSurface(),expected=nsCodecToRgba(r);
                for(let y=0;y<15;y++)for(let x=0;x<16;x++)for(let c=0;c<4;c++){
                    if(actual[((y+4)*40+x+3)*4+c]!==expected[(y*w+x)*4+c])
                        throw new Error(`${name} NSCodec pixel mismatch sub=${sub} loss=${loss} bpp=${bpp} at (${x},${y},${c})`);
                }
                pixels+=16*15;
            }
            if(failures.length)throw new Error(failures.join('; '));
            results.push({backend:name,available:true,pixels,differences:0,gpuHardwareQualified:false});
        }finally{renderer.destroy();canvas.remove();}
    }
    if(!results.some(r=>r.backend==='Canvas'&&r.available))throw new Error('Canvas comparison missing');
    return results;
}"""


def main() -> None:
    subprocess.run(['npm', 'run', 'build:pages'], cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix='rdp-surface-') as temporary:
        temp=Path(temporary); shutil.copytree(ROOT/'dist/pages',temp/'RDP')
        server=http.server.ThreadingHTTPServer(('127.0.0.1',8799),functools.partial(http.server.SimpleHTTPRequestHandler,directory=str(temp)))
        threading.Thread(target=server.serve_forever,daemon=True).start()
        with (temp/'gateway.log').open('w+') as log:
            gateway=subprocess.Popen(['node','tests/fixtures/GatewayBrowser.js'],cwd=ROOT,env={**os.environ,'RDP_SURFACE_FIXTURE':'1'},stdout=log,stderr=subprocess.STDOUT)
            try:
                deadline=time.monotonic()+15
                while True:
                    if gateway.poll() is not None:log.seek(0);raise RuntimeError(log.read())
                    try:
                        with socket.create_connection(('127.0.0.1',8798),timeout=.25):break
                    except OSError:
                        if time.monotonic()>=deadline:raise RuntimeError('Gateway startup timed out')
                        time.sleep(.05)
                with sync_playwright() as pw:
                    executable=os.environ.get('CHROMIUM') or shutil.which('google-chrome') or shutil.which('chromium')
                    browser=pw.chromium.launch(headless=True,executable_path=executable)
                    try:
                        page=browser.new_page(viewport={'width':1440,'height':1100});errors=[]
                        page.on('pageerror',lambda e:errors.append(str(e)));page.goto('http://127.0.0.1:8799/RDP/')
                        comparisons=page.evaluate(COMPARE)
                        page.evaluate(PROBE)
                        page.locator('#gateway-url').fill('http://127.0.0.1:8798');page.locator('#bridge-token').fill('browser-fixture-token-0123456789abcdef')
                        page.locator('#load-targets').click();expect(page.locator('#form-message')).to_contain_text('1 allowlisted target',timeout=15000)
                        page.locator('#backend').select_option('canvas');page.locator('#username').fill('User');page.locator('#domain').fill('LAB');page.locator('#password').fill('Password')
                        page.locator('details').filter(has=page.locator('#surface-graphics')).locator('summary').click()
                        expect(page.locator('#surface-graphics')).not_to_be_checked();page.locator('#surface-graphics').check();page.locator('#surface-quality').select_option('balanced')
                        page.locator('#resize').uncheck();page.locator('#connect-button').click()
                        expect(page.locator('.session-foot')).to_contain_text('active',timeout=15000)
                        canvas=page.locator('.screen-host canvas')
                        def output() -> str:log.flush();log.seek(0);return log.read()
                        def barrier() -> dict:
                            n=output().count('SURFACE_BARRIER ');canvas.focus();canvas.press('b');deadline=time.monotonic()+10
                            while output().count('SURFACE_BARRIER ')<=n:
                                if time.monotonic()>deadline:raise AssertionError({'log':output(),'probe':page.evaluate('()=>surfaceProbe'),'overlay':page.locator('.session-overlay').inner_text(),'pageErrors':errors})
                                page.wait_for_timeout(20)
                            return json.loads(output().split('SURFACE_BARRIER ')[-1].splitlines()[0])
                        def wait_for(predicate) -> dict:
                            deadline=time.monotonic()+15
                            while True:
                                value=barrier()
                                if predicate(value):return value
                                if time.monotonic()>deadline:raise AssertionError({'barrier':value,'errors':errors,'log':output()})
                                page.wait_for_timeout(20)
                        def pixel(x:int,y:int) -> list:
                            return canvas.evaluate('(c,p)=>[...c.getContext("2d").getImageData(p[0],p[1],1,1).data]',[x,y])
                        page.wait_for_function('()=>surfaceProbe.received>=1')
                        expect(canvas).to_be_visible()
                        page.wait_for_function('()=>{const c=document.querySelector(".screen-host canvas"),p=c?.getContext("2d")?.getImageData(4,5,1,1).data;return p&&p[0]===3&&p[1]===2&&p[2]===1;}')
                        assert pixel(4,5)==[3,2,1,255]
                        assert barrier()['acks']==[]
                        page.evaluate('()=>surfaceProbe.hold=true');canvas.press('e')
                        page.wait_for_function('()=>surfaceProbe.gates.length>0');assert barrier()['acks']==[]
                        assert pixel(4,5)!=[3,2,1,255]  # Applied but completion fence deliberately unresolved.
                        page.evaluate('()=>{surfaceProbe.hold=false;for(const release of surfaceProbe.gates.splice(0))release();}')
                        wait_for(lambda v:v['acks']==[101])
                        def compare_tile(swap:bool=False,crop:bool=False) -> None:
                            for y in range(5):
                                for x in range(7):
                                    at=((4-y)//2)*4+x//2;co=((at%9)-4)*4;cg=((at%5)-2)*4;luma=50+(x*3+(4-y)*9)%140
                                    rgb=[max(0,min(255,luma+co-cg)),max(0,min(255,luma+cg)),max(0,min(255,luma-co-cg))]
                                    if swap:rgb[0],rgb[2]=rgb[2],rgb[0]
                                    expected=[70,80,90,255] if crop and x==2 and y==2 else rgb+[255]
                                    assert pixel(x+4,y+5)==expected,(x,y,pixel(x+4,y+5),expected)
                        compare_tile();canvas.press('f');wait_for(lambda v:v['acks']==[101,102]);compare_tile(True,True)
                        assert page.evaluate('()=>surfaceProbe.groups.some(g=>g.length===2&&g[0]==="nscodec"&&g[1]==="raw")')
                        canvas.press('l');wait_for(lambda v:v['acks']==[101,102,103]);assert pixel(100,100)==[60,50,40,255]
                        # Input sent during reactivation is intentionally discarded by Session.
                        # Await a NEW active transition before sending the keyboard barrier;
                        # old visible 'active' text or Confirm Active alone is not sufficient.
                        active_count=page.evaluate('()=>surfaceProbe.activeCount')
                        canvas.press('r')
                        page.wait_for_function('(n)=>surfaceProbe.activeCount===n+1',arg=active_count,timeout=15000)
                        assert page.evaluate('()=>surfaceProbe.states.includes("reactivating")')
                        wait_for(lambda v:v['confirms']==2)
                        page.wait_for_function('()=>{const p=document.querySelector(".screen-host canvas").getContext("2d").getImageData(4,5,1,1).data;return p[0]===3&&p[1]===2&&p[2]===1;}')
                        assert pixel(4,5)==[3,2,1,255]
                        canvas.press('e');wait_for(lambda v:v['acks']==[101,102,103,201]);compare_tile()
                        canvas.press('x');expect(page.locator('.session-overlay')).to_contain_text('SURFACE_CODEC',timeout=15000)
                        assert errors==[],errors
                        result={'renderers':comparisons,'atomicFrame':True,'presentationGatedAck':True,'multiFragment':True,
                            'frameOverGatewayWindow':True,'reactivation':True,'unnegotiatedCodecRejected':True,'independentWindowsInterop':False}
                        print(json.dumps(result,indent=2))
                    finally:browser.close()
            finally:
                gateway.terminate()
                try:gateway.wait(timeout=10)
                except subprocess.TimeoutExpired:gateway.kill();gateway.wait(timeout=5)
                server.shutdown();server.server_close()
                if gateway.returncode not in (0,-15):log.seek(0);print(log.read())

if __name__=='__main__':main()
