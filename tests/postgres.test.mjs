import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConnection, addressKind, resolveTarget, clientOptions } from '../lib/postgres.mjs';
const input={host:'localhost',database:'app',user:'reader'};
test('connection validation only accepts bounded connection fields',()=>{
  assert.equal(validateConnection(input).tls,'verify');
  for(const patch of [{host:'https://db.example'},{host:'/tmp'},{port:0},{port:'5432'},{password:'x'.repeat(4097)},{database:'a\0b'},{ssl:false},{tls:'disable'},{ca:'invalid'},{user:''}])assert.throws(()=>validateConnection({...input,...patch}));
});
test('egress rejects metadata, unspecified and multicast addresses including IPv6 aliases',()=>{
  for(const addr of ['169.254.169.254','0.0.0.0','224.0.0.1','::','fe80::1','ff02::1','::ffff:169.254.169.254','::ffff:a9fe:a9fe'])assert.equal(addressKind(addr),'blocked',addr);
  for(const addr of ['127.0.0.1','::1','::ffff:127.0.0.1'])assert.equal(addressKind(addr),'loopback',addr);
  assert.equal(addressKind('10.0.0.10'),'allowed');assert.equal(addressKind('fd00::123'),'allowed');
});
test('resolved address is pinned and non-loopback targets always require verified TLS',async()=>{
  const remote=async()=>[{address:'10.0.0.10',family:4}];
  await assert.rejects(resolveTarget({...input,tls:'local'},remote),{code:'TLS_REQUIRED'});
  await assert.rejects(resolveTarget({...input,tls:'verify'},async()=>[{address:'10.0.0.10',family:4},{address:'169.254.169.254',family:4}]),{code:'TARGET'});
  const opts=await clientOptions(validateConnection(input),remote);assert.equal(opts.host,'10.0.0.10');assert.equal(opts.ssl.servername,'localhost');assert.equal(opts.ssl.rejectUnauthorized,true);assert.match(opts.options,/read_only=on/);assert.equal(typeof opts.password,'function');assert.equal(opts.password(),'');
});
