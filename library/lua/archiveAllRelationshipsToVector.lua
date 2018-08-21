local itemKey = ARGV[1]
local vector = ARGV[2]

-- Retrieve all the tripple where the item is the subject.
local SPOTrippleList = redis.call('ZRANGEBYLEX', itemKey, '[SPO:'.. vector ..':', '[SPO:'.. vector ..'\xff')
-- Retrieve all the tripple where the item is the object.
local OPSTrippleList = redis.call('ZRANGEBYLEX', itemKey, '[OPS:'.. vector ..':', '[OPS:'.. vector ..'\xff')

redis.log(redis.LOG_DEBUG, string.format("Nucleus: Retrieved %s relationship(s) for vector %s.", table.getn(SPOTrippleList) + table.getn(OPSTrippleList), vector));

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

-- Archive a tripple
local function archiveTripple(itemKey, subject, predicate, object)
    redis.call('ZREM', itemKey, 'SPO:'..subject..':'..predicate..':'..object)
    redis.call('ZREM', itemKey, 'SOP:'..subject..':'..object..':'..predicate)
    redis.call('ZREM', itemKey, 'OPS:'..object..':'..predicate..':'..subject)
    redis.call('ZREM', itemKey, 'OSP:'..object..':'..subject..':'..predicate)
    redis.call('ZREM', itemKey, 'PSO:'..predicate..':'..subject..':'..object)
    redis.call('ZREM', itemKey, 'POS:'..predicate..':'..object..':'..subject)

    redis.call('ZADD', itemKey, 0, '*SPO:'..subject..':'..predicate..':'..object)
    redis.call('ZADD', itemKey, 0, '*SOP:'..subject..':'..object..':'..predicate)
    redis.call('ZADD', itemKey, 0, '*OPS:'..object..':'..predicate..':'..subject)
    redis.call('ZADD', itemKey, 0, '*OSP:'..object..':'..subject..':'..predicate)
    redis.call('ZADD', itemKey, 0, '*PSO:'..predicate..':'..subject..':'..object)
    redis.call('ZADD', itemKey, 0, '*POS:'..predicate..':'..object..':'..subject)

    redis.log(redis.LOG_DEBUG, string.format("Nucleus: Archived the relationship between %s, %s and %s.", subject, predicate, object));
end

for index, tripple in pairs(SPOTrippleList) do

    local splittedTripple = splitTripple(tripple)
    local subject = vector
    local predicate = splittedTripple[3]
    local object = splittedTripple[4]

    archiveTripple(itemKey, subject, predicate, object)
end

for index, tripple in pairs(OPSTrippleList) do

    local splittedTripple = splitTripple(tripple)
    local subject = splittedTripple[4]
    local predicate = splittedTripple[3]
    local object = vector

    if predicate ~= "is-authored-by" then
        archiveTripple(itemKey, subject, predicate, object)
    end
end

return { SPOTrippleList, OPSTrippleList }