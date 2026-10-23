// A late response belongs to the request's account epoch, never to the next login.
export class SessionState {
  constructor(account){this.account=account;this.epoch=0;this.controllers=new Set();}
  ticket(){const controller=new AbortController();this.controllers.add(controller);return {account:this.account,epoch:this.epoch,controller};}
  accepts(ticket){return !!this.account&&ticket.account===this.account&&ticket.epoch===this.epoch&&!ticket.controller.signal.aborted;}
  finish(ticket){this.controllers.delete(ticket.controller);}
  clear(){this.epoch++;this.account=null;for(const c of this.controllers)c.abort();this.controllers.clear();}
}
