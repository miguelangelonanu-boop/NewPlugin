--[[
	StudioPilot - Roblox Studio plugin
	==================================

	Install: copy this file into Roblox Studio's Plugins folder
	(Studio > Plugins > "Plugins Folder"), then restart Studio.

	This plugin long-polls the local StudioPilot bridge (bridge.py) over HTTP,
	executes the commands the AI sends (read/edit scripts, run Luau, inspect the
	game tree...) and posts the results back. Roblox has no WebSocket client, so
	plain HTTP long-polling is used - the latency is still effectively instant.

	NOTE: enable HTTP if Studio asks: Game Settings > Security >
	"Enable Studio Access to API Services". Loopback (127.0.0.1) is local-only:
	the plugin never talks to anything except the bridge on your own machine.
]]

local PLUGIN_VERSION = "1.0.0"
local BRIDGE_BASE = "http://127.0.0.1:17655" -- must match studio_port in config.json
local POLL_WAIT_SECONDS = 25                 -- long-poll window (bridge caps it too)
local RETRY_SECONDS = 2                      -- delay after a failed request
local LOG_BUFFER_MAX = 500

local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")
local Selection = game:GetService("Selection")
local InsertService = game:GetService("InsertService")
local ScriptEditorService = game:GetService("ScriptEditorService")

-- ---------------------------------------------------------------------------
-- State
-- ---------------------------------------------------------------------------

local enabled = false
local loopToken = 0            -- increment to stop the current poll loop
local connected = false
local jobsDone = 0
local lastError = nil
local logCounter = 0
local logBuffer = {}           -- ring buffer of {id=, type=, text=}

-- ---------------------------------------------------------------------------
-- Log capture (Output window)
-- ---------------------------------------------------------------------------

LogService.MessageOut:Connect(function(message, messageType)
	logCounter = logCounter + 1
	table.insert(logBuffer, {
		id = logCounter,
		type = tostring(messageType.Name),
		text = tostring(message),
	})
	if #logBuffer > LOG_BUFFER_MAX then
		table.remove(logBuffer, 1)
	end
end)

-- ---------------------------------------------------------------------------
-- Widget UI
-- ---------------------------------------------------------------------------

local toolbar = plugin:CreateToolbar("StudioPilot")
local toggleButton = toolbar:CreateButton(
	"StudioPilotToggle",
	"Toggle the StudioPilot AI agent connection",
	"", -- no icon asset; text button
	"StudioPilot: OFF"
)

local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right,
	false,  -- initially hidden
	false,  -- override enabled state
	260, 300,
	220, 200
)
local widget = plugin:CreateDockWidgetPluginGui("StudioPilotPanel", widgetInfo)
widget.Title = "StudioPilot"

local root = Instance.new("Frame")
root.BackgroundColor3 = Color3.fromRGB(30, 30, 34)
root.BorderSizePixel = 0
root.Parent = widget

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 8)
padding.PaddingLeft = UDim.new(0, 8)
padding.PaddingRight = UDim.new(0, 8)
padding.PaddingBottom = UDim.new(0, 8)
padding.Parent = root

local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 6)
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Parent = root

local function makeLabel(order, text, bold, color)
	local l = Instance.new("TextLabel")
	l.LayoutOrder = order
	l.BackgroundTransparency = 1
	l.Size = UDim2.new(1, 0, 0, bold and 22 or 16)
	l.Font = bold and Enum.Font.SourceSansBold or Enum.Font.SourceSans
	l.TextSize = bold and 16 or 13
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.TextColor3 = color or Color3.fromRGB(220, 220, 224)
	l.TextWrapped = true
	l.AutomaticSize = Enum.AutomaticSize.Y
	l.Text = text
	l.Parent = root
	return l
end

local statusLabel = makeLabel(1, "StudioPilot v" .. PLUGIN_VERSION, true)
local bridgeLabel = makeLabel(2, "Bridge: not connected", false, Color3.fromRGB(255, 170, 90))
local jobsLabel = makeLabel(3, "Jobs completed: 0")
local errorLabel = makeLabel(4, "", false, Color3.fromRGB(255, 110, 110))
local hintLabel = makeLabel(5, "Start bridge.py on your PC, open the chat page " ..
	"(Claude / ChatGPT / Arena) and press 'Start session' in the StudioPilot bar.",
	false, Color3.fromRGB(150, 150, 160))

local function refreshUi()
	toggleButton:SetText(enabled and "StudioPilot: ON" or "StudioPilot: OFF")
	if not enabled then
		bridgeLabel.Text = "Agent stopped (click the toolbar button to start)"
		bridgeLabel.TextColor3 = Color3.fromRGB(150, 150, 160)
	elseif connected then
		bridgeLabel.Text = "Bridge: connected (" .. BRIDGE_BASE .. ")"
		bridgeLabel.TextColor3 = Color3.fromRGB(120, 220, 130)
	else
		bridgeLabel.Text = "Bridge: not connected - run start.bat / MacOS_Start.command"
		bridgeLabel.TextColor3 = Color3.fromRGB(255, 170, 90)
	end
	jobsLabel.Text = "Jobs completed: " .. tostring(jobsDone)
	errorLabel.Text = lastError and ("Last error: " .. lastError) or ""
	if lastError and string.find(lastError, "not enabled") then
		hintLabel.Text = "HTTP requests are blocked: enable Game Settings > Security > " ..
			"'Enable Studio Access to API Services', then toggle again."
	elseif not connected and enabled then
		hintLabel.Text = "Can't reach the bridge. Run start.bat (Windows) or " ..
			"MacOS_Start.command (macOS/Linux) first."
	else
		hintLabel.Text = "Start bridge.py on your PC, open the chat page " ..
			"(Claude / ChatGPT / Arena) and press 'Start session' in the StudioPilot bar."
	end
end

-- ---------------------------------------------------------------------------
-- HTTP helpers
-- ---------------------------------------------------------------------------

local function httpGet(path)
	local url = BRIDGE_BASE .. path
	local ok, res = pcall(function()
		return HttpService:RequestAsync({ Url = url, Method = "GET" })
	end)
	if not ok then
		return nil, tostring(res)
	end
	if not res.Success then
		return nil, "HTTP " .. tostring(res.StatusCode) .. ": " .. tostring(res.Body)
	end
	local decodeOk, decoded = pcall(function()
		return HttpService:JSONDecode(res.Body)
	end)
	if not decodeOk then
		return nil, "bad JSON from bridge"
	end
	return decoded, nil
end

local function httpPost(path, tbl)
	local body = HttpService:JSONEncode(tbl)
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = BRIDGE_BASE .. path,
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = body,
		})
	end)
	if not ok then
		return nil, tostring(res)
	end
	local decodeOk, decoded = pcall(function()
		return HttpService:JSONDecode(res.Body)
	end)
	if res.Success and decodeOk then
		return decoded, nil
	end
	return nil, "HTTP " .. tostring(res.StatusCode) .. ": " .. tostring(res.Body)
end

-- ---------------------------------------------------------------------------
-- Path resolving  ("game.Workspace.Part" | "Workspace/Part" | game["My Part"].X)
-- ---------------------------------------------------------------------------

local function tokenizePath(path)
	local segs = {}
	local i = 1
	local n = #path
	while i <= n do
		local c = string.sub(path, i, i)
		if c == "." or c == "/" then
			i = i + 1
		elseif c == "[" then
			local closePos = string.find(path, "]", i, true)
			if not closePos then
				return nil, "unclosed '[' in path"
			end
			local inner = string.sub(path, i + 1, closePos - 1)
			inner = string.gsub(inner, '^"(.*)"$', "%1")
			inner = string.gsub(inner, "^'(.*)'$", "%1")
			table.insert(segs, inner)
			i = closePos + 1
		else
			local s, e = string.find(path, "^[^%./%[]+", i)
			if not s then
				return nil, "invalid path near position " .. tostring(i)
			end
			table.insert(segs, string.sub(path, s, e))
			i = e + 1
		end
	end
	return segs, nil
end

local function isServiceName(name)
	local ok = pcall(function()
		return game:GetService(name)
	end)
	return ok
end

local function resolvePath(path)
	if type(path) ~= "string" or path == "" then
		return nil, "path must be a non-empty string"
	end
	if path == "game" or path == "game." or path == "game/" then
		return game, nil
	end
	local segs, terr = tokenizePath(path)
	if not segs then
		return nil, terr
	end
	if #segs > 0 and segs[1] == "game" then
		table.remove(segs, 1)
	end
	if #segs == 0 then
		return game, nil
	end
	local node
	local first = table.remove(segs, 1)
	if isServiceName(first) then
		node = game:GetService(first)
	else
		node = game:FindFirstChild(first)
		if not node then
			return nil, "not a service and no child of game named '" .. first .. "'"
		end
	end
	for _, seg in ipairs(segs) do
		local child = node:FindFirstChild(seg)
		if not child then
			return nil, "no child '" .. seg .. "' under " .. node:GetFullName()
		end
		node = child
	end
	return node, nil
end

local function segmentName(name)
	if string.match(name, "^[%a_][%w_]*$") then
		return name
	end
	return string.format("[%q]", name)
end

local function instancePath(inst)
	if inst == game then
		return "game"
	end
	local parts = {}
	local node = inst
	while node and node ~= game do
		table.insert(parts, 1, segmentName(node.Name))
		node = node.Parent
	end
	return "game." .. table.concat(parts, ".")
end

-- ---------------------------------------------------------------------------
-- JSON -> Luau value conversion for set_property
-- ---------------------------------------------------------------------------

local function jsonToValue(v)
	if type(v) ~= "table" then
		return v -- string/number/boolean pass through
	end
	local t = v.__type or v["$type"]
	if t == "Vector3" then
		return Vector3.new(v.x or 0, v.y or 0, v.z or 0)
	elseif t == "Vector2" then
		return Vector2.new(v.x or 0, v.y or 0)
	elseif t == "Color3" then
		local r, g, b = v.r or 0, v.g or 0, v.b or 0
		if r > 1 or g > 1 or b > 1 then
			r, g, b = r / 255, g / 255, b / 255
		end
		return Color3.new(r, g, b)
	elseif t == "BrickColor" then
		return BrickColor.new(v.name or "Medium stone grey")
	elseif t == "UDim2" then
		return UDim2.new(v.sx or 0, v.ox or 0, v.sy or 0, v.oy or 0)
	elseif t == "UDim" then
		return UDim.new(v.s or 0, v.o or 0)
	elseif t == "NumberRange" then
		return NumberRange.new(v.min or 0, v.max or 0)
	elseif t == "Rect" then
		return Rect.new(v.minX or 0, v.minY or 0, v.maxX or 0, v.maxY or 0)
	elseif t == "CFrame" then
		local c = v.components or {}
		if #c >= 12 then
			return CFrame.new(c[1], c[2], c[3], c[4], c[5], c[6],
				c[7], c[8], c[9], c[10], c[11], c[12])
		elseif #c >= 3 then
			return CFrame.new(c[1], c[2], c[3])
		end
		return CFrame.new()
	elseif t == "Enum" then
		-- "Enum.Material.Grass"
		local full = v.enum or ""
		local _, _, cat, item = string.find(full, "^Enum%.([%w_]+)%.([%w_]+)$")
		if cat and item then
			local okVal, enumItem = pcall(function()
				return Enum[cat][item]
			end)
			if okVal and enumItem ~= nil then
				return enumItem
			end
		end
		return nil, "bad enum: " .. tostring(full)
	end
	-- plain table: recurse. Arrays become arrays, objects become dictionaries.
	local isArray = #v > 0
	local out = {}
	if isArray then
		for _, item in ipairs(v) do
			table.insert(out, jsonToValue(item))
		end
	else
		for k, item in pairs(v) do
			out[k] = jsonToValue(item)
		end
	end
	return out
end

-- ---------------------------------------------------------------------------
-- Script source editing (ScriptEditorService is the supported API)
-- ---------------------------------------------------------------------------

local function setSource(scriptInst, source)
	local ok, err = pcall(function()
		ScriptEditorService:UpdateSourceAsync(scriptInst, function()
			return source
		end)
	end)
	if ok then
		return true, nil
	end
	-- fallback: direct assignment (works for ModuleScripts in some versions)
	local ok2, err2 = pcall(function()
		scriptInst.Source = source
	end)
	if ok2 then
		return true, nil
	end
	return false, tostring(err) .. " | " .. tostring(err2)
end

-- ---------------------------------------------------------------------------
-- Command implementations. Each returns a result table (JSON-encodable).
-- ---------------------------------------------------------------------------

local handlers = {}

handlers.ping = function()
	return {
		pong = true,
		pluginVersion = PLUGIN_VERSION,
		placeName = game.Name,
		placeId = game.PlaceId,
		studioVersion = version(),
	}
end

handlers.get_scripts = function()
	local out = {}
	for _, inst in ipairs(game:GetDescendants()) do
		if inst:IsA("LuaSourceContainer") then
			table.insert(out, { path = instancePath(inst), className = inst.ClassName })
			if #out >= 5000 then
				break
			end
		end
	end
	return { count = #out, scripts = out }
end

handlers.read_script = function(cmd)
	local inst, err = resolvePath(cmd.path)
	if not inst then
		return { ok = false, error = err }
	end
	if not inst:IsA("LuaSourceContainer") then
		return { ok = false, error = instancePath(inst) .. " is not a script (it is a " .. inst.ClassName .. ")" }
	end
	local okSrc, src = pcall(function()
		return inst.Source
	end)
	if not okSrc then
		return { ok = false, error = "could not read Source: " .. tostring(src) }
	end
	return { ok = true, path = instancePath(inst), className = inst.ClassName, source = src, length = #src }
end

local ALLOWED_CLASSES = { Script = true, LocalScript = true, ModuleScript = true, Folder = true }

handlers.set_script = function(cmd)
	local path = cmd.path
	local source = cmd.source
	local className = cmd.className or "Script"
	if not ALLOWED_CLASSES[className] then
		return { ok = false, error = "className must be Script, LocalScript, ModuleScript or Folder" }
	end
	if type(source) ~= "string" then
		return { ok = false, error = "source must be a string" }
	end

	-- does it already exist?
	local existing = resolvePath(path)
	if existing then
		if not existing:IsA("LuaSourceContainer") then
			return { ok = false, error = instancePath(existing) .. " exists but is not a script" }
		end
		local okSet, setErr = setSource(existing, source)
		if not okSet then
			return { ok = false, error = "could not set Source: " .. tostring(setErr) }
		end
		return { ok = true, path = instancePath(existing), action = "updated", length = #source }
	end

	-- create the chain
	local segs, terr = tokenizePath(path)
	if not segs then
		return { ok = false, error = terr }
	end
	if #segs > 0 and segs[1] == "game" then
		table.remove(segs, 1)
	end
	if #segs < 2 then
		return { ok = false, error = "path must include a parent service, e.g. game.ServerScriptService.MyScript" }
	end
	local first = table.remove(segs, 1)
	local node
	if isServiceName(first) then
		node = game:GetService(first)
	else
		node = game:FindFirstChild(first)
		if not node then
			return { ok = false, error = "no parent service or child named '" .. first .. "'" }
		end
	end
	while #segs > 1 do
		local seg = table.remove(segs, 1)
		local child = node:FindFirstChild(seg)
		if not child then
			child = Instance.new("Folder")
			child.Name = seg
			child.Parent = node
		end
		node = child
	end
	local finalName = segs[1]
	if node:FindFirstChild(finalName) then
		return { ok = false, error = "an instance named '" .. finalName .. "' already exists there but resolvePath missed it" }
	end
	local newInst = Instance.new(className)
	newInst.Name = finalName
	newInst.Parent = node
	local okSet, setErr = setSource(newInst, source)
	if not okSet then
		pcall(function()
			newInst:Destroy()
		end)
		return { ok = false, error = "created but could not set Source: " .. tostring(setErr) }
	end
	return { ok = true, path = instancePath(newInst), action = "created", length = #source }
end
handlers.create_script = handlers.set_script

handlers.delete_script = function(cmd)
	local inst, err = resolvePath(cmd.path)
	if not inst then
		return { ok = false, error = err }
	end
	local p = instancePath(inst)
	pcall(function()
		inst:Destroy()
	end)
	return { ok = true, deleted = p }
end

handlers.run_code = function(cmd)
	local code = cmd.code
	if type(code) ~= "string" then
		return { ok = false, error = "code must be a string" }
	end
	local chunk, loadErr = loadstring(code, "StudioPilot")
	if not chunk then
		return { ok = false, error = "load error: " .. tostring(loadErr) }
	end

	local printed = {}
	local function capture(prefix, ...)
		local n = select("#", ...)
		local parts = {}
		for i = 1, n do
			parts[i] = tostring(select(i, ...))
		end
		table.insert(printed, prefix .. table.concat(parts, "\t"))
	end
	local fakeEnv = {
		print = function(...)
			capture("", ...)
		end,
		warn = function(...)
			capture("[warn] ", ...)
		end,
		plugin = plugin,
	}
	setmetatable(fakeEnv, { __index = getfenv(1) })
	setfenv(chunk, fakeEnv)

	local t0 = os.clock()
	local results = table.pack(pcall(chunk))
	local dt = os.clock() - t0
	local okRun = results[1]
	local returned = {}
	for i = 2, results.n do
		table.insert(returned, tostring(results[i]))
	end
	return {
		ok = okRun,
		error = (not okRun) and tostring(results[2]) or nil,
		returned = (#returned > 0 and not not okRun) and table.concat(returned, "\t") or nil,
		output = table.concat(printed, "\n"),
		durationMs = math.floor(dt * 1000 + 0.5),
		runContext = "Studio edit mode (plugin permissions; not a live server)"
	}
end

handlers.get_tree = function(cmd)
	local rootPath = cmd.path or "game"
	local maxDepth = tonumber(cmd.maxDepth) or 4
	local maxLines = 2500
	local rootInst, err = resolvePath(rootPath)
	if not rootInst then
		return { ok = false, error = err }
	end
	local lines = {}
	local truncated = false
	local function walk(inst, depth)
		if #lines >= maxLines then
			truncated = true
			return
		end
		local extra = ""
		if inst:IsA("LuaSourceContainer") then
			extra = "  [" .. inst.ClassName .. "]"
		end
		table.insert(lines, string.rep("  ", depth) .. inst.Name .. " (" .. inst.ClassName .. ")" .. extra)
		if depth < maxDepth then
			local children = inst:GetChildren()
			for _, child in ipairs(children) do
				walk(child, depth + 1)
				if truncated then
					return
				end
			end
		end
	end
	walk(rootInst, 0)
	return { ok = true, truncated = truncated, tree = table.concat(lines, "\n"), lines = #lines }
end

handlers.set_property = function(cmd)
	local inst, err = resolvePath(cmd.path)
	if not inst then
		return { ok = false, error = err }
	end
	local prop = cmd.property
	if type(prop) ~= "string" or prop == "" then
		return { ok = false, error = "property must be a string" }
	end
	if inst:IsA("LuaSourceContainer") and prop == "Source" then
		local okSet, setErr = setSource(inst, tostring(cmd.value))
		return { ok = okSet, error = setErr, path = instancePath(inst), property = prop }
	end
	local value, convErr = jsonToValue(cmd.value)
	if convErr then
		return { ok = false, error = convErr }
	end
	local okSet, setErr = pcall(function()
		inst[prop] = value
	end)
	if not okSet then
		return { ok = false, error = "could not set " .. prop .. ": " .. tostring(setErr) }
	end
	return { ok = true, path = instancePath(inst), property = prop }
end

handlers.insert_asset = function(cmd)
	local assetId = tonumber(cmd.assetId)
	if not assetId then
		return { ok = false, error = "assetId must be a number" }
	end
	local parent = workspace
	if cmd.parentPath then
		local p, perr = resolvePath(cmd.parentPath)
		if not p then
			return { ok = false, error = perr }
		end
		parent = p
	end
	local okLoad, container = pcall(function()
		return InsertService:LoadAsset(assetId)
	end)
	if not okLoad then
		return {
			ok = false,
			error = "LoadAsset failed (asset must be owned by you or Roblox/Creator Store): " .. tostring(container),
		}
	end
	local inserted = {}
	for _, child in ipairs(container:GetChildren()) do
		child.Parent = parent
		table.insert(inserted, instancePath(child))
	end
	if #inserted == 0 then
		container.Parent = parent
		table.insert(inserted, instancePath(container))
	end
	return { ok = true, inserted = inserted }
end

handlers.get_console_output = function(cmd)
	local afterId = tonumber(cmd.afterId) or 0
	local out = {}
	for _, entry in ipairs(logBuffer) do
		if entry.id > afterId then
			table.insert(out, entry)
			if #out >= 300 then
				break
			end
		end
	end
	return { ok = true, lastId = logCounter, count = #out, lines = out }
end

handlers.get_selection = function()
	local sel = Selection:Get()
	local out = {}
	for _, inst in ipairs(sel) do
		table.insert(out, { path = instancePath(inst), className = inst.ClassName })
	end
	return { ok = true, count = #out, selection = out }
end

-- ---------------------------------------------------------------------------
-- Job execution
-- ---------------------------------------------------------------------------

local function executeCommand(cmd)
	local actionName = cmd.action
	local handler = handlers[actionName]
	if not handler then
		return {
			action = actionName,
			ok = false,
			error = "unknown action '" .. tostring(actionName) .. "'. Available: ping, get_scripts, " ..
				"read_script, set_script, create_script, delete_script, run_code, get_tree, " ..
				"set_property, insert_asset, get_console_output, get_selection",
		}
	end
	local okCall, result = pcall(handler, cmd)
	if not okCall then
		return { action = actionName, ok = false, error = "handler crashed: " .. tostring(result) }
	end
	if type(result) ~= "table" then
		result = { value = tostring(result) }
	end
	result.action = actionName
	if result.ok == nil then
		result.ok = true
	end
	return result
end

-- ---------------------------------------------------------------------------
-- Poll loop
-- ---------------------------------------------------------------------------

local function pollLoop(token)
	local placeLabel = HttpService:UrlEncode(game.Name)
	local pollPath = "/api/poll?wait=" .. tostring(POLL_WAIT_SECONDS)
		.. "&place=" .. placeLabel
		.. "&placeId=" .. tostring(game.PlaceId)
		.. "&pluginVersion=" .. PLUGIN_VERSION
	while enabled and loopToken == token do
		local body, err = httpGet(pollPath)
		if loopToken ~= token or not enabled then
			break
		end
		if body == nil then
			if connected or lastError ~= err then
				connected = false
				lastError = err
				refreshUi()
			end
			task.wait(RETRY_SECONDS)
		else
			if not connected or lastError then
				connected = true
				lastError = nil
				refreshUi()
			end
			if body.commands then
				local results = {}
				for index, c in ipairs(body.commands) do
					results[index] = executeCommand(c)
				end
				local postOk, postErr = httpPost("/api/result", { id = body.id, results = results })
				if postOk then
					jobsDone = jobsDone + 1
					lastError = nil
				else
					lastError = "result post failed: " .. tostring(postErr)
				end
				refreshUi()
			end
		end
	end
end

local function setEnabled(on)
	if enabled == on then
		return
	end
	enabled = on
	loopToken = loopToken + 1
	if on then
		widget.Enabled = true
		task.spawn(function()
			pollLoop(loopToken)
		end)
	end
	refreshUi()
end

toggleButton.Click:Connect(function()
	setEnabled(not enabled)
end)

plugin.Unloading:Connect(function()
	setEnabled(false)
end)

refreshUi()

-- Auto-start the agent connection when the plugin loads.
setEnabled(true)
