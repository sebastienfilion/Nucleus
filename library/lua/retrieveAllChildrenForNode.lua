local itemKey = ARGV[1]
local nodeListStringified = ARGV[2]

local nodeList = loadstring('return '..nodeListStringified)()
local childNodeListAccumulator = {};

local function contains(table, element)
    for _, value in pairs(table) do
        if value == element then
            return true
        end
    end
    return false
end

-- Splits a tripple into a table
local function splitTripple (tripple)
    local splittedTripple = {}
    local index = 1
    for vector in string.gmatch(tripple, "([^:]+)") do
        splittedTripple[index] = vector
        index = index + 1
    end

    return splittedTripple
end


-- Retrieve the ancestor for a given node
local function retrieveAllChildrenForNode (node)
    local nodeList = {};

    local function recursivelyRetrieveChildrenForNode(node)
        local childrenNodeList = redis.call('ZRANGEBYLEX', itemKey, '[OPS:'.. node ..':is-member-of', '[OPS:'.. node ..':is-member-of:\xff')
        local archivedChildrenNodeList = redis.call('ZRANGEBYLEX', itemKey, '[*OPS:'.. node ..':is-member-of', '[*OPS:'.. node ..':is-member-of:\xff')

        if (table.getn(childrenNodeList) == 0 and table.getn(archivedChildrenNodeList) == 0) then return true end

        redis.log(redis.LOG_DEBUG, string.format("Nucleus: Retrieved %s children(s) for vector %s.", table.getn(childrenNodeList) + table.getn(archivedChildrenNodeList), node));

        if (table.getn(archivedChildrenNodeList) ~= 0) then
            for index, tripple in pairs(archivedChildrenNodeList) do
               table.insert(childrenNodeList, tripple);
            end
        end

        for index, tripple in pairs(childrenNodeList) do
            local relationshipIsArchived = string.sub(tripple, 1, 1) == '*'

            if (relationshipIsArchived) then
                tripple = string.sub(tripple, 1)
            end

            local splittedTripple = splitTripple(tripple)
            local object = node
            local predicate = splittedTripple[3]
            local subject = splittedTripple[4]

            if subject == 'SYSTEM' then return true end

            local ancestorIsAlreadyRetrieved = contains(nodeList, subject);

            if (not ancestorIsAlreadyRetrieved) then
                table.insert(nodeList, subject)

                recursivelyRetrieveChildrenForNode(subject, nodeList)
            end
        end

    end

    recursivelyRetrieveChildrenForNode(node)

    return nodeList
end

for index, node in pairs(nodeList) do
    if (redis.call('EXISTS', 'NodeList:HierarchyTreeDownward:' .. node) == 1) then
        local cachedAncestorNodeList = redis.call('SMEMBERS', 'NodeList:HierarchyTreeDownward:' .. node)

        table.insert(childNodeListAccumulator, cachedAncestorNodeList)
    else
        local childNodeList = retrieveAllChildrenForNode(node)

        table.insert(childNodeListAccumulator, childNodeList)
    end
end

return childNodeListAccumulator;