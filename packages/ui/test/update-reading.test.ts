import {noDesktopUpdates,type DesktopUpdateSnapshot,type DesktopUpdates,type DesktopUpdateReply} from "@clawtrate/core";
import {it,expect,vi} from "vitest";
import {UpdateReading} from "../src/update-reading.ts";

const base:DesktopUpdateSnapshot={revision:3,runningVersion:"1.0.0",runningTrack:"stable",tracks:[{track:"stable",source:"stable.example"},{track:"nightly",source:"nightly.example"}],selectedTrack:"stable",pendingTrack:null,preferenceIssue:null,lastCheck:null,install:{kind:"unavailable-in-this-build"},state:{kind:"not-checked"}};
function harness() {
 const first=Promise.withResolvers<DesktopUpdateSnapshot>();
 const reply=Promise.withResolvers<DesktopUpdateReply>();
 let event=(s:DesktopUpdateSnapshot)=>{void s;};
 const stop=vi.fn();
 const host={...noDesktopUpdates,get:()=>first.promise, subscribe:vi.fn(fn=>{event=fn;return stop;}),check:vi.fn(()=>reply.promise),download:vi.fn(()=>reply.promise),chooseTrack:vi.fn(()=>reply.promise)} satisfies DesktopUpdates;
 const reader=new UpdateReading(host);
 const disconnect=reader.connect();
 return {reader,host,first,reply,stop,disconnect,event:(s:DesktopUpdateSnapshot)=>event(s)};
}
it("F-231: a newer offer survives an old check reply and an older initial read",async()=>{
 const h=harness();h.event({...base,revision:2});
 const check=h.reader.check("stable");void h.reader.check("stable");
 const newest:DesktopUpdateSnapshot={...base,revision:5,state:{kind:"offered",version:"1.1.0",releaseDate:"2026-11-01",offerId:"offer-B"}};
 h.event(newest);h.reply.resolve({outcome:"stale",snapshot:{...base,revision:4}});await check;
 h.first.resolve(base);await h.first.promise;
 expect(h.reader.get()).toMatchObject({snapshot:newest,message:null,working:false});
 expect(h.host.check.mock.calls).toEqual([["stable"]]);expect(h.host.subscribe).toHaveBeenCalledTimes(1);h.disconnect();expect(h.stop).toHaveBeenCalledOnce();
});
it("F-231: a stale download carries only the displayed identity and accepts its replacement",async()=>{
 const h=harness();h.event(base);const done=h.reader.download("A");
 h.reply.resolve({outcome:"stale",snapshot:{...base,revision:4,state:{kind:"offered",version:"2.0.0",releaseDate:"2026-11-01",offerId:"B"}}});await done;
 expect(h.host.download.mock.calls).toEqual([["A"]]);expect(h.reader.get().snapshot?.state).toMatchObject({offerId:"B"});expect(h.reader.get().message).toBeNull();
});
it.each(["busy","superseded","stale","invalid"] as const)("F-231: handles %s once at the same revision",async outcome=>{
 const h=harness();h.event(base);const done=h.reader.check("stable");h.reply.resolve({snapshot:base,outcome});await done;
 expect(h.reader.get().message).toBe(outcome==="busy"?null:outcome==="invalid"?"Couldn't start the update check.":"The update track changed. Check the selected source again.");expect(h.host.check).toHaveBeenCalledOnce();
});
it("F-231: rejected reads and commands release the action without replay",async()=>{
 const h=harness();h.first.reject(Error());await vi.waitFor(()=>expect(h.reader.get().message).toBe("Couldn't read update settings."));
 h.event(base);h.host.check.mockRejectedValueOnce(Error());await h.reader.check("stable");
 expect(h.reader.get().message).toBe("Couldn't start the update check.");h.reply.resolve({outcome:"busy",snapshot:base});await h.reader.check("stable");expect(h.host.check).toHaveBeenCalledTimes(2);
});

it("F-231: a track choice masks the old offer immediately and rejects overlapping local commands",async()=>{
 const h=harness();h.event(base);const saving=h.reader.chooseTrack("nightly");
 expect(h.reader.get().localChoice).toBe("nightly");
 await h.reader.check("stable");await h.reader.download("retired");await h.reader.chooseTrack("nightly");
 expect(h.host.check).not.toHaveBeenCalled();expect(h.host.download).not.toHaveBeenCalled();expect(h.host.chooseTrack).toHaveBeenCalledOnce();
 h.event({...base,revision:4,pendingTrack:"nightly"});
 h.reply.resolve({outcome:"accepted",snapshot:{...base,revision:5,preferenceIssue:"track-not-saved"}});
 await saving;expect(h.reader.get()).toMatchObject({localChoice:null,snapshot:{selectedTrack:"stable",state:{kind:"not-checked"},preferenceIssue:"track-not-saved"}});
});
