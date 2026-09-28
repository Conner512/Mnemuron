"""Real browser UI contracts. Uses the caller's disposable account and page.
No production credentials, CSP bypass, network redirects or mocked successes.
"""
from playwright.sync_api import expect


def choose_select(page, selector, value):
    native = page.locator(selector)
    expect(native).to_have_count(1)
    # Read only the index; exercise the actual visible trigger and option.
    index = native.evaluate('(s, value) => Array.from(s.options).findIndex(o => o.value === value)', value)
    if index < 0:
        raise AssertionError('Missing option: ' + selector + ' / ' + str(value))
    trigger = native.locator('..').locator('> .select-trigger')
    expect(trigger).to_be_enabled()
    trigger.click()
    popup = page.locator('#' + trigger.get_attribute('aria-controls'))
    popup.locator('[data-index="' + str(index) + '"]').click()
    expect(native).to_have_value(value)
    expect(trigger).to_have_attribute('aria-expanded', 'false')


def check_selects(page, goto, check, previews):
    goto('memories')
    trigger = page.locator('[data-select-name="search_mode"]')
    native = page.locator('[name="search_mode"]')
    expect(trigger).to_be_visible()
    check('Select enhancement retains exactly one native named control', native.count() == 1)
    check('Preferences and filters share one combobox implementation', page.get_by_role('combobox').count() == 6)
    check('Library preserves real column headers', page.locator('.memory-table th').count() == 4)
    page.evaluate('''() => {
      window.selectEvents = {input: 0, change: 0};
      const s = document.querySelector('[name="search_mode"]');
      s.addEventListener('input', () => window.selectEvents.input++);
      s.addEventListener('change', () => window.selectEvents.change++);
    }''')
    trigger.click()
    popup = page.locator('#' + trigger.get_attribute('aria-controls'))
    expect(popup).to_be_visible()
    box, control = popup.bounding_box(), trigger.bounding_box()
    check('Search popup is anchored below its own trigger, not the selected row', abs(box['y'] - control['y'] - control['height'] - 6) < 2 and abs(box['x'] - control['x']) < 2)
    check('Search popup matches its control width', abs(box['width'] - control['width']) < 2)
    page.keyboard.press('ArrowDown'); page.keyboard.press('Escape')
    expect(native).to_have_value('lexical')
    check('Escape cancels preview without change events', page.evaluate('() => window.selectEvents') == {'input': 0, 'change': 0})
    expect(trigger).to_be_focused()
    trigger.click(); page.keyboard.press('ArrowDown'); page.keyboard.press('Enter')
    expect(native).to_have_value('hybrid')
    check('Enter commits exactly one native input/change pair', page.evaluate('() => window.selectEvents') == {'input': 1, 'change': 1})
    check('Original FormData receives the chosen value', page.locator('#search-form').evaluate("f => new FormData(f).get('search_mode')") == 'hybrid')
    trigger.click(); page.keyboard.press('End'); page.keyboard.press('Tab')
    expect(native).to_have_value('semantic')
    check('Tab commits the highlighted option and leaves the control', not trigger.evaluate('e => e === document.activeElement'))
    trigger.click(); page.keyboard.press('Home'); page.locator('#console-root h1').click()
    expect(native).to_have_value('semantic')
    check('Outside click dismisses without committing a preview', page.locator('.select-popup:popover-open').count() == 0)
    choose_select(page, '[name="search_mode"]', 'lexical')
    trigger.click(); page.locator('[data-select-name="theme"]').click()
    check('Only one select popup can be open', page.locator('.select-popup:popover-open').count() == 1)
    page.keyboard.press('Escape')
    page.locator('.account-menu summary').click(); trigger.click()
    check('Opening a select closes the account menu without submitting logout', page.locator('.account-menu[open]').count() == 0)
    page.keyboard.press('Escape')
    page.locator('[name="query"]').fill('Synthetic draft C9800-CL')
    requests = []
    listener = lambda request: requests.append(request.url) if '/console-api/' in request.url else None
    page.on('request', listener)
    choose_select(page, '#locale', 'en')
    choose_select(page, '#theme', 'b')
    choose_select(page, '#mode', 'dark')
    expect(page.locator('[name="query"]')).to_have_value('Synthetic draft C9800-CL')
    check('Appearance selection neither submits business requests nor resets form drafts', not requests)
    page.remove_listener('request', listener)
    trigger.click(); page.keyboard.press('s'); page.keyboard.press('Enter')
    expect(native).to_have_value('semantic')
    check('Typeahead uses translated option labels', 'Semantic' in trigger.inner_text())
    choose_select(page, '#locale', 'zh-CN'); choose_select(page, '#theme', 'a'); choose_select(page, '#mode', 'light')
    choose_select(page, '[name="search_mode"]', 'lexical')
    page.locator('[name="query"]').fill('')

    # Layout and open-popup geometry, including English labels and all palettes.
    for width in [1280, 1440, 1920]:
        page.set_viewport_size({'width': width, 'height': 1000})
        for theme in ['a', 'b', 'c']:
            for mode in ['light', 'dark']:
                for locale in ['zh-CN', 'en']:
                    choose_select(page, '#theme', theme); choose_select(page, '#mode', mode); choose_select(page, '#locale', locale)
                    page.locator('[data-select-name="category"]').click()
                    pop = page.locator('.select-popup:popover-open'); r = pop.bounding_box()
                    fit = page.evaluate('() => document.documentElement.scrollWidth <= innerWidth')
                    check('Anchored dropdown / desktop layout ' + str((width, theme, mode, locale)), fit and r['x'] >= 0 and r['x'] + r['width'] <= width + 1 and r['y'] >= 0 and r['y'] + r['height'] <= 1001)
                    page.keyboard.press('Escape')
    page.set_viewport_size({'width': 1440, 'height': 1100})
    choose_select(page, '#theme', 'a'); choose_select(page, '#mode', 'light'); choose_select(page, '#locale', 'zh-CN')
    trigger.click(); page.screenshot(path=str(previews / 'memory-search-dropdown.png'), full_page=True); page.keyboard.press('Escape')
    page.locator('[data-select-name="theme"]').click(); page.screenshot(path=str(previews / 'theme-dropdown.png'), full_page=True); page.keyboard.press('Escape')
    choose_select(page, '#theme', 'b'); choose_select(page, '#mode', 'dark')
    trigger.click(); page.screenshot(path=str(previews / 'memory-dropdown-dark.png'), full_page=True); page.keyboard.press('Escape')
    choose_select(page, '#theme', 'a'); choose_select(page, '#mode', 'light')

    # Synthetic DOM fixture exercises semantics not present in every business form.
    page.evaluate('''() => {
      const form = document.createElement('form'); form.id = 'select-probe';
      Object.assign(form.style, {position:'fixed', bottom:'18px', right:'8px', width:'210px', padding:'10px', background:'var(--surface)', zIndex:'20'});
      const label = document.createElement('label'); label.textContent = 'Synthetic required choice';
      const select = document.createElement('select'); select.name = 'probe'; select.required = true;
      for (const [value,text,disabled,hidden] of [['','Choose',false,false],['a','Alpha',false,false],['x','Disabled',true,false],['h','Hidden',false,true],['b','Beta',false,false]]) {
        const o = new Option(text,value); o.disabled = disabled; o.hidden = hidden; select.add(o);
      }
      const group = document.createElement('optgroup'); group.label = 'Unavailable group'; group.disabled = true; group.append(new Option('Gamma','g')); select.append(group);
      label.append(select); form.append(label);
      const submit=document.createElement('button'); submit.type='submit'; submit.textContent='Validate'; form.append(submit);
      const reset=document.createElement('button'); reset.type='reset'; reset.textContent='Reset'; form.append(reset);
      form.addEventListener('submit', e => {e.preventDefault(); window.probeSubmitted=true;});
      document.body.append(form);
    }''')
    probe = page.locator('[data-select-name="probe"]'); expect(probe).to_be_visible()
    page.locator('#select-probe button[type=submit]').click()
    expect(probe).to_have_attribute('aria-invalid', 'true')
    check('Required validation focuses the visible combobox and does not submit', probe.evaluate('e => e === document.activeElement') and not page.evaluate('() => !!window.probeSubmitted'))
    probe.click(); pop = page.locator('.select-popup:popover-open')
    expect(pop).to_have_attribute('data-side', 'top')
    check('Bottom-edge popup flips upward and clamps its right edge', pop.bounding_box()['x'] + pop.bounding_box()['width'] <= 1431)
    check('Hidden options excluded, disabled group retained as disabled', pop.locator('[data-index="3"]').count() == 0 and pop.locator('[data-index="5"]').get_attribute('aria-disabled') == 'true')
    page.keyboard.press('ArrowDown'); page.keyboard.press('ArrowDown'); page.keyboard.press('Enter')
    expect(page.locator('[name=probe]')).to_have_value('b')
    check('Keyboard skips disabled options and disabled groups', probe.get_attribute('aria-invalid') == 'false')
    page.locator('#select-probe button[type=reset]').click()
    expect(page.locator('[name=probe]')).to_have_value('')
    expect(probe).to_have_text('Choose')
    check('Native form reset updates visible value', probe.get_attribute('aria-invalid') == 'false')
    page.locator('[name=probe]').evaluate("s => {s.add(new Option('Delta','d'));s.disabled=true;}")
    expect(probe).to_be_disabled()
    page.locator('[name=probe]').evaluate('s => {s.disabled=false;}')
    expect(probe).to_be_enabled(); choose_select(page, '[name=probe]', 'd')
    check('Dynamic options and disabled state remain synchronized')
    probe.click(); page.locator('#select-probe').evaluate('f => f.remove()')
    expect(page.locator('.select-popup:popover-open')).to_have_count(0)
    check('Removing a form also removes its active popup')

    # A popup must stay inside the dialog DOM and paint above its scroll clip.
    page.evaluate('''() => {
      const d = document.createElement('dialog'); d.id='select-probe-dialog';
      Object.assign(d.style,{inset:'0',margin:'auto',width:'540px',height:'360px',padding:'24px',maxHeight:'80vh',overflow:'auto'});
      const label=document.createElement('label');label.textContent='Synthetic modal select';label.style.marginTop='220px';
      const s=document.createElement('select');s.name='modal_probe';for(let i=0;i<24;i++)s.add(new Option('Long option '+i,'v'+i));label.append(s);d.append(label);
      const spacer=document.createElement('div');spacer.style.height='300px';d.append(spacer);document.body.append(d);d.showModal();
    }''')
    modal_trigger = page.locator('[data-select-name="modal_probe"]'); expect(modal_trigger).to_be_visible(); modal_trigger.click()
    pop = page.locator('.select-popup:popover-open')
    check('Modal select uses top layer without moving outside its owning dialog', pop.evaluate("p => p.closest('dialog').id") == 'select-probe-dialog')
    page.locator('#select-probe-dialog').evaluate('d => {d.scrollTop += 80;}');page.wait_for_timeout(80)
    r, c = pop.bounding_box(), modal_trigger.bounding_box()
    check('Popup follows modal scrolling without clipping', abs(r['x']-c['x'])<2 and (abs(r['y']-c['y']-c['height']-6)<2 or abs(r['y']+r['height']+6-c['y'])<2))
    page.keyboard.press('End');page.keyboard.press('Enter');expect(page.locator('[name=modal_probe]')).to_have_value('v23')
    modal_trigger.click();page.keyboard.press('Escape');check('First Escape dismisses select, not parent dialog', page.locator('#select-probe-dialog').get_attribute('open') is not None)
    page.keyboard.press('Escape');expect(page.locator('#select-probe-dialog')).not_to_be_visible()
    page.locator('#select-probe-dialog').evaluate('d => d.remove()')
    goto('memories')
    # Device zoom equivalents shrink CSS viewport; overflow remains local to tables.
    page.set_viewport_size({'width': 960, 'height': 700});page.locator('[data-select-name="status"]').click()
    pop = page.locator('.select-popup:popover-open');r=pop.bounding_box()
    check('Compact desktop viewport keeps popup in view', r['x']>=0 and r['x']+r['width']<=961 and r['y']+r['height']<=701)
    page.keyboard.press('Escape');page.set_viewport_size({'width':1440,'height':1100})
