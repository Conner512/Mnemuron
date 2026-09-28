"""Real browser connection onboarding with synthetic accounts. Never screenshot secrets."""
from console_select_checks import choose_select

def check_connections(page,goto,check,cmd,cfg,close,previews):
    goto('connections')
    check('Connection hub provides a real onboarding entry',page.locator('[data-connection-wizard]').count()==1)
    check('Legacy credentials and grants start collapsed',page.locator('details.connection-secondary[open]').count()==0)
    page.locator('[data-connection-wizard]').click()
    page.locator('#operation-dialog [data-connection-guide="agents"]').click()
    check('Agent templates are clearly reserved, not fake setup actions',page.locator('#operation-dialog [data-console-action]').count()==0)
    close()

    def start(kind):
        page.locator('.connection-hub [data-connection-guide="'+kind+'"]').first.click()
        page.locator('#operation-dialog [data-console-action="cloud_connections.create"]').click()
        page.locator('#operation-dialog form').wait_for()
    def proof():
        page.locator('#operation-dialog [name=current_password]').fill(cfg['password'])
        page.locator('#operation-dialog [name=otp]').fill(cmd('fresh_cloud_otp')['otp'])
    def submit():
        with page.expect_response(lambda r:r.url.endswith('/console-api/action') and r.request.method=='POST') as response:
            page.locator('#operation-dialog button[type=submit]').click()
        r=response.value
        assert r.status==200,'Connection operation returned '+str(r.status)
        page.locator('#operation-dialog .operation-result').wait_for()
        return r.json()

    start('mcp');page.locator('[name=label]').fill('Synthetic MCP connection')
    choose_select(page,'#operation-dialog [name=permission]','readwrite')
    proof();mcp=submit();old=mcp['access_token']
    check('Generic MCP wizard issues an actual scoped token',old.startswith('mnmc_') and 'memory:write' in mcp['scopes'])
    check('PAT validates through the authenticated authorization server',cmd('inspect_cloud',token=old)['active'])
    close()
    check('Inventory never repeats the generated token',old not in page.inner_text('body'))
    page.locator('[data-connection-guide="mcp"][data-id="'+mcp['connection_id']+'"]').click()
    check('Existing connection guide uses a placeholder, not a recovered secret','<YOUR_MCP_ACCESS_TOKEN>' in page.inner_text('#operation-content') and old not in page.inner_text('#operation-content'))
    close()
    start('chatgpt');page.locator('[name=label]').fill('Synthetic ChatGPT connection')
    page.locator('[name=redirect_uri]').fill(cfg['callback_uri']);proof();oauth=submit()
    check('ChatGPT wizard issues dedicated client ID and secret',oauth['client_id'].startswith('mnmconn_') and len(oauth['client_secret'])>=43 and oauth['client_secret']!=old)
    close()
    check('OAuth secret is absent from the post-issuance DOM',oauth['client_secret'] not in page.inner_text('body'))
    page.locator('[data-console-action="cloud_connections.rotate"][data-id="'+mcp['connection_id']+'"]').click();proof();rotation=submit()
    check('Connection rotation invalidates the old token',not cmd('inspect_cloud',token=old)['active'] and cmd('inspect_cloud',token=rotation['access_token'])['active'])
    close()
    page.locator('[data-console-action="cloud_connections.revoke"][data-id="'+mcp['connection_id']+'"]').click();proof();revoked=submit()
    check('Connection revocation reaches the actual authorization state',revoked['status']=='revoked' and not cmd('inspect_cloud',token=rotation['access_token'])['active'])
    close()
    page.locator('[data-connection-status="history"]').click()
    page.get_by_text('Synthetic MCP connection',exact=True).wait_for()
    check('Revoked connections move to history without deletion',page.locator('[data-console-action="cloud_connections.rotate"][data-id="'+mcp['connection_id']+'"]').count()==0)
    page.locator('[data-connection-status="active"]').click();page.get_by_text('Synthetic ChatGPT connection',exact=True).wait_for()
    page.locator('#connection-query').fill('does-not-match-synthetic')
    page.locator('#connection-search-form button[type=submit]').click()
    page.get_by_text('Synthetic ChatGPT connection',exact=True).wait_for(state='detached')
    check('Connection search is backed by filtered API results',page.locator('.connection-hub tbody tr').count()==0)
    page.locator('#connection-query').fill('');page.locator('#connection-search-form button[type=submit]').click()
    page.get_by_text('Synthetic ChatGPT connection',exact=True).wait_for()
    for width in [1280,1440,1920]:
        page.set_viewport_size({'width':width,'height':1100})
        for theme in ['a','b','c']:
            for mode in ['light','dark']:
                choose_select(page,'#theme',theme);choose_select(page,'#mode',mode)
                check('Connection hub fits desktop '+str((width,theme,mode)),page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    page.set_viewport_size({'width':1440,'height':1100})
    choose_select(page,'#theme','a');choose_select(page,'#mode','light');choose_select(page,'#locale','zh-CN')
    page.screenshot(path=str(previews/'connections-hub.png'),full_page=True)
    page.locator('.connection-hub [data-connection-guide="chatgpt"]').first.click()
    page.screenshot(path=str(previews/'chatgpt-connection-guide.png'),full_page=True);close()
