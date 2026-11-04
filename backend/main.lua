local logger     = require("logger")
local millennium = require("millennium")

-- The plugin needs no backend logic; this only tells Millennium it is ready.
local function on_load()
    logger:info("Delisted Capsule Fix loaded (Millennium " .. millennium.version() .. ")")
    millennium.ready()
end

local function on_unload()
    logger:info("Delisted Capsule Fix unloaded")
end

return {
    on_load = on_load,
    on_unload = on_unload,
}
