-- Logs into oversoles.com in the user's real macOS Chrome.
--
-- Usage:  osascript scripts/oversoles-auto-login.applescript <emailB64> <passwordB64>
--
-- Returns on stdout:  ok|<finalURL>
-- On any failure, raises an AppleScript error with a clear message.
--
-- Requirement: Chrome > View > Developer > Allow JavaScript from Apple Events
-- must be ENABLED. The wrapping refresh script detects when it isn't and
-- prints actionable instructions.
--
-- OBSERVABLE-MODE: there's a `stepDelay` between every action so the user
-- can watch each step happen in Chrome and diagnose. Tune at the top.

on run argv
	if (count of argv) is less than 2 then
		error "expected two arguments: emailB64 passwordB64"
	end if
	set emailB64 to item 1 of argv
	set passwordB64 to item 2 of argv
	set stepDelay to 3 -- seconds between each visible action

	tell application "Google Chrome"
		activate
		if (count of windows) is 0 then make new window
		set theWindow to front window

		-- Open a fresh tab on about:blank so we have a known starting state.
		log "[applescript] opening fresh tab on about:blank"
		set theTab to make new tab at end of tabs of theWindow with properties {URL:"about:blank"}
		delay stepDelay

		-- Step 1 — logout. Hit /account/logout and wait until Shopify
		-- redirects us off that URL (which means the session was actually
		-- invalidated server-side).
		log "[applescript] navigating to /account/logout"
		set URL of theTab to "https://oversoles.com/account/logout"
		set logoutDone to false
		repeat 15 times
			delay 1
			set currentURL to URL of theTab
			if currentURL does not contain "/account/logout" then
				set logoutDone to true
				exit repeat
			end if
		end repeat
		if not logoutDone then error "logout did not complete in 15s"
		log "[applescript] logout redirected → " & currentURL
		delay stepDelay

		-- Step 2 — navigate to /account/login, poll for the form to render.
		log "[applescript] navigating to /account/login"
		set URL of theTab to "https://oversoles.com/account/login"
		set formReady to false
		repeat 20 times
			delay 1
			set checkScript to "(!!document.querySelector('#CustomerEmail')) ? 'yes' : 'no'"
			try
				set hasForm to execute theTab javascript checkScript
				if hasForm is "yes" then
					set formReady to true
					exit repeat
				end if
			end try
		end repeat
		if not formReady then error "login form (#CustomerEmail) did not appear in 20s"
		log "[applescript] login form rendered"
		delay stepDelay

		-- Step 3 — fill email + password.
		log "[applescript] filling email + password"
		set fillScript to "(() => {" & ¬
			"const setN = (sel, val) => { const el = document.querySelector(sel); if (!el) return false;" & ¬
			"const proto = el.tagName==='TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;" & ¬
			"Object.getOwnPropertyDescriptor(proto,'value').set.call(el, val);" & ¬
			"el.dispatchEvent(new Event('input',{bubbles:true}));" & ¬
			"el.dispatchEvent(new Event('change',{bubbles:true})); return true; };" & ¬
			"const email = atob('" & emailB64 & "');" & ¬
			"const password = atob('" & passwordB64 & "');" & ¬
			"return setN('#CustomerEmail', email) && setN('#CustomerPassword', password) ? 'ok' : 'fields-missing';" & ¬
			"})()"
		set fillResult to execute theTab javascript fillScript
		if fillResult is not equal to "ok" then error "fill failed: " & fillResult
		log "[applescript] fields filled"
		delay stepDelay

		-- Step 4 — submit.
		log "[applescript] clicking submit"
		set clickScript to "(() => { const f = document.querySelector('form#customer_login'); if (!f) return 'no-form'; const b = f.querySelector('button.login__sign-in') || f.querySelector('button[type=\"submit\"]') || f.querySelector('button:not([type=\"button\"])') || f.querySelector('button'); if (b) { b.click(); return 'clicked'; } if (typeof f.requestSubmit==='function') { f.requestSubmit(); return 'requestSubmit'; } return 'no-submit-path'; })()"
		set clickResult to execute theTab javascript clickScript
		if clickResult is "no-form" or clickResult is "no-submit-path" then
			error "submit failed: " & clickResult
		end if
		log "[applescript] submit result: " & clickResult

		-- Step 5 — wait for redirect away from /account/login (up to 90s).
		set didRedirect to false
		set finalURL to ""
		repeat 90 times
			delay 1
			try
				set finalURL to URL of theTab
				if finalURL does not contain "/account/login" then
					set didRedirect to true
					exit repeat
				end if
			end try
		end repeat
		if not didRedirect then
			set errScript to "(() => { const e = document.querySelector('.errors, .form__message--error, [class*=\"error\"], .alert'); return e ? e.innerText.slice(0,300) : '(no error element on page)'; })()"
			set errText to ""
			try
				set errText to execute theTab javascript errScript
			end try
			error "no redirect off /account/login within 90s. page error text: " & errText
		end if
		log "[applescript] login redirected → " & finalURL
		delay stepDelay

		-- Step 6 — close the tab. Closing is one of Chrome's "save cookies now"
		-- triggers; without it, the rotated _shopify_essential cookie may sit
		-- in Chrome's in-memory jar for tens of seconds before flushing to the
		-- on-disk SQLite that chrome-cookies-secure reads.
		log "[applescript] closing tab to force cookie flush"
		try
			close theTab
		end try

		return "ok|" & finalURL
	end tell
end run
